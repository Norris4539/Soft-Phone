#!/usr/bin/env node
/**
 * Provisioning for extensions, ring groups and queues.
 *
 * config/users.json is the single source of truth: this script hashes any
 * plaintext passwords in place, fills in missing SIP secrets and voicemail
 * PINs, and renders the four Asterisk config fragments that the static
 * configuration includes.  Asterisk never reads users.json itself, and the
 * control server reads it only to authenticate logins.
 *
 * Usage:
 *   node scripts/manage-users.mjs apply
 *   node scripts/manage-users.mjs list
 *   node scripts/manage-users.mjs add --ext 104 --name "Dana Weiss" [--role agent]
 *                                     [--queues support:0,sales:2] [--groups reception]
 *                                     [--email dana@example.com] [--password secret]
 *   node scripts/manage-users.mjs passwd --ext 104 [--password secret]
 *   node scripts/manage-users.mjs remove --ext 104
 *
 * Every command that changes anything re-renders the config; reload Asterisk
 * afterwards with `make reload` (or restart the stack).
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USERS_FILE = join(ROOT, 'config', 'users.json');
const EXAMPLE_FILE = join(ROOT, 'config', 'users.example.json');
const CONF_DIR = join(ROOT, 'infra', 'asterisk', 'conf');

const VOICEMAIL_CONTEXT = 'switchboard';
const GENERATED_HEADER = [
  '; ---------------------------------------------------------------------',
  '; GENERATED FILE — do not edit.',
  '; Written by scripts/manage-users.mjs from config/users.json.',
  '; ---------------------------------------------------------------------',
  '',
].join('\n');

// --- password hashing ------------------------------------------------------
// scrypt from node's standard library rather than bcrypt: no native module to
// build in two different images, and it is a sound choice for this.  The
// server side of this lives in server/src/password.ts and must stay in step
// with the encoding below.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    // scrypt's default maxmem is too small for N=16384 with r=8.
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

// Exercised by `apply` so a bad encoding surfaces here rather than at login.
function verifyPassword(plain, stored) {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(plain, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(expected, actual);
}

// --- helpers ---------------------------------------------------------------
function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function randomSecret(bytes = 18) {
  // URL-safe: SIP passwords travel in config files and curl commands, and a
  // '/' or '+' in one is a reliable source of an afternoon's confusion.
  return randomBytes(bytes).toString('base64url');
}

function randomPin() {
  return String(randomInt(1000, 10000));
}

function loadUsers() {
  if (!existsSync(USERS_FILE)) {
    die(
      `${USERS_FILE} not found.\n` +
        `       Start from the example:  cp config/users.example.json config/users.json`,
    );
  }
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    die(`${USERS_FILE} is not valid JSON: ${err.message}`);
  }
}

function saveUsers(db) {
  mkdirSync(dirname(USERS_FILE), { recursive: true });
  writeFileSync(USERS_FILE, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

/** Asterisk config values are not quoted; a stray newline would inject a line. */
function safe(value, field) {
  const str = String(value ?? '');
  if (/[\r\n]/.test(str)) die(`${field} may not contain a line break`);
  return str;
}

// --- validation ------------------------------------------------------------
function validate(db) {
  if (!db || typeof db !== 'object') die('users.json must be a JSON object');
  if (!Array.isArray(db.users)) die('users.json needs a "users" array');

  const seen = new Set();
  for (const user of db.users) {
    const ext = String(user.extension ?? '');
    // The dialplan matches extensions with the pattern _1XX, so anything
    // outside 100-199 would be provisioned but unreachable.
    if (!/^1\d{2}$/.test(ext)) {
      die(`extension "${ext}" must be three digits starting with 1 (100-199)`);
    }
    if (seen.has(ext)) die(`extension ${ext} is defined twice`);
    seen.add(ext);

    if (!user.name) die(`extension ${ext} has no name`);
    if (user.role && !['agent', 'admin'].includes(user.role)) {
      die(`extension ${ext} has role "${user.role}"; expected "agent" or "admin"`);
    }
    for (const group of user.groups ?? []) {
      if (!db.ringGroups?.[group]) {
        die(`extension ${ext} is in ring group "${group}", which is not defined`);
      }
    }
    for (const entry of user.queues ?? []) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!db.queues?.[name]) {
        die(`extension ${ext} is in queue "${name}", which is not defined`);
      }
    }
    if (user.did && !/^\+?\d{3,20}$/.test(String(user.did))) {
      die(`extension ${ext} has an unusable did "${user.did}"`);
    }
  }

  for (const [name] of Object.entries(db.ringGroups ?? {})) {
    if (!/^[a-z0-9_-]+$/i.test(name)) die(`ring group "${name}" must be alphanumeric`);
  }
  for (const [name] of Object.entries(db.queues ?? {})) {
    if (!/^[a-z0-9_-]+$/i.test(name)) die(`queue "${name}" must be alphanumeric`);
  }
}

/** Fill in anything the operator left out.  Returns true if the file changed. */
function normalise(db) {
  let changed = false;
  const generated = [];

  for (const user of db.users) {
    user.extension = String(user.extension);
    user.role ??= 'agent';
    user.groups ??= [];
    user.queues ??= [];

    // Queue membership is accepted as either "support" or {name, penalty}.
    user.queues = user.queues.map((entry) =>
      typeof entry === 'string' ? { name: entry, penalty: 0 } : { penalty: 0, ...entry },
    );

    if (!user.sipPassword) {
      user.sipPassword = randomSecret();
      changed = true;
    }
    if (!user.voicemailPin) {
      user.voicemailPin = randomPin();
      changed = true;
    }
    if (!user.password) {
      const plain = randomSecret(9);
      user.password = hashPassword(plain);
      generated.push({ extension: user.extension, password: plain });
      changed = true;
    } else if (!isHashed(user.password)) {
      const plain = String(user.password);
      user.password = hashPassword(plain);
      if (!verifyPassword(plain, user.password)) {
        die('internal: password hash failed to verify immediately after hashing');
      }
      changed = true;
    }
  }

  if (generated.length > 0) {
    console.log('\nGenerated web logins (shown once — they are hashed in users.json):');
    for (const entry of generated) {
      console.log(`  extension ${entry.extension}  password ${entry.password}`);
    }
    console.log('');
  }

  return changed;
}

// --- rendering -------------------------------------------------------------
function renderPjsipEndpoints(db) {
  const lines = [GENERATED_HEADER];

  for (const user of db.users) {
    const ext = user.extension;
    const name = safe(user.name, 'name');
    lines.push(
      `; --- ${name} (${ext}) ---`,
      `[${ext}](webrtc-endpoint)`,
      `auth = ${ext}`,
      `aors = ${ext}`,
      `callerid = ${name} <${ext}>`,
      `mailboxes = ${ext}@${VOICEMAIL_CONTEXT}`,
      // Read back by the [outbound] context; blank means "use the main DID".
      `set_var = OUTBOUND_CID=${safe(user.outboundCallerId ?? '', 'outboundCallerId')}`,
      // Lets the dashboard tie an ARI channel back to a directory entry
      // without parsing the endpoint name out of the channel string.
      `set_var = EXTENSION_NAME=${name}`,
      '',
      `[${ext}](webrtc-auth)`,
      `username = ${ext}`,
      `password = ${safe(user.sipPassword, 'sipPassword')}`,
      '',
      `[${ext}](webrtc-aor)`,
      '',
    );
  }

  return lines.join('\n');
}

function renderExtensionsUsers(db) {
  const lines = [GENERATED_HEADER];

  // Hints power the dashboard's presence column and any BLF-capable handset.
  lines.push('[internal](+)', '');
  for (const user of db.users) {
    lines.push(`exten => ${user.extension},hint,PJSIP/${user.extension}`);
  }
  lines.push('');

  lines.push('[ring-groups](+)', '');
  for (const [name, group] of Object.entries(db.ringGroups ?? {})) {
    const members = db.users.filter((u) => (u.groups ?? []).includes(name));
    lines.push(`; ${safe(group.description ?? name, 'description')}`);

    if (members.length === 0) {
      // An empty ring group must not silently answer and hang up; send it to
      // the shared voicemail tail like any other unanswered group.
      lines.push(
        `exten => ${name},1,NoOp(Ring group ${name} has no members)`,
        ' same => n,Goto(no-answer,1)',
        '',
      );
      continue;
    }

    const timeout = Number(group.timeout ?? 25);
    lines.push(`exten => ${name},1,NoOp(Ring group ${name})`);
    lines.push(` same => n,Set(CDR(userfield)=group-${name})`);

    if (group.strategy === 'sequential') {
      // Ring one after another; each Dial falls through to the next on any
      // non-answer, and an answered call never reaches the following line.
      for (const member of members) {
        lines.push(` same => n,Dial(PJSIP/${member.extension},${timeout},tT)`);
      }
    } else {
      const dialString = members.map((m) => `PJSIP/${m.extension}`).join('&');
      lines.push(` same => n,Dial(${dialString},${timeout},tT)`);
    }

    lines.push(' same => n,Goto(no-answer,1)', '');
  }

  return lines.join('\n');
}

function renderExtensionsDid(db) {
  const lines = [GENERATED_HEADER, '[switchboard-inbound](+)', ''];

  const withDid = db.users.filter((u) => u.did);
  if (withDid.length === 0) {
    lines.push('; no per-extension DIDs configured', '');
  }

  for (const user of withDid) {
    lines.push(
      `; ${safe(user.name, 'name')} — direct dial ${safe(user.did, 'did')}`,
      `exten => direct-${user.extension},1,NoOp(Direct DID to ${user.extension})`,
      ' same => n,Answer()',
      ` same => n,Goto(internal-dial,${user.extension},1)`,
      '',
    );
  }

  return lines.join('\n');
}

function renderVoicemail(db) {
  const lines = [GENERATED_HEADER, `[${VOICEMAIL_CONTEXT}]`, ''];

  for (const user of db.users) {
    const options = ['attach=yes', 'tz=local', `saycid=yes`];
    lines.push(
      `${user.extension} => ${safe(user.voicemailPin, 'voicemailPin')},` +
        `${safe(user.name, 'name')},` +
        `${safe(user.email ?? '', 'email')},,` +
        options.join('|'),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderQueues(db) {
  const lines = [GENERATED_HEADER];

  for (const [name, queue] of Object.entries(db.queues ?? {})) {
    const members = db.users
      .map((u) => ({ user: u, entry: (u.queues ?? []).find((q) => q.name === name) }))
      .filter((m) => m.entry);

    lines.push(
      `; ${safe(queue.description ?? name, 'description')}`,
      `[${name}]`,
      `strategy = ${safe(queue.strategy ?? 'rrmemory', 'strategy')}`,
      `timeout = ${Number(queue.timeout ?? 20)}`,
      `wrapuptime = ${Number(queue.wrapuptime ?? 10)}`,
      `musicclass = ${safe(queue.musicClass ?? 'queue-hold', 'musicClass')}`,
      // Tell the caller where they are in the line; silence is what makes
      // people hang up.
      `announce-frequency = ${Number(queue.announceFrequency ?? 60)}`,
      'announce-holdtime = yes',
      'announce-position = yes',
      // Do not offer a call to an agent who is already on one.
      'ringinuse = no',
      'autopause = no',
      // Retry/​servicelevel defaults that suit a small team.
      'retry = 5',
      'servicelevel = 60',
      `timeoutrestart = yes`,
      `maxlen = 0`,
    );

    for (const { user, entry } of members) {
      lines.push(
        `member => PJSIP/${user.extension},${Number(entry.penalty ?? 0)},${safe(user.name, 'name')}`,
      );
    }
    if (members.length === 0) {
      lines.push('; no members — calls will wait out maxWait and go to voicemail');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeIfChanged(filename, contents) {
  const path = join(CONF_DIR, filename);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous === contents) return false;
  mkdirSync(CONF_DIR, { recursive: true });
  writeFileSync(path, contents);
  return true;
}

// --- commands --------------------------------------------------------------
function cmdApply() {
  const db = loadUsers();
  validate(db);
  if (normalise(db)) saveUsers(db);
  validate(db);

  const written = [
    ['pjsip_endpoints.conf', renderPjsipEndpoints(db)],
    ['extensions_users.conf', renderExtensionsUsers(db)],
    ['extensions_did.conf', renderExtensionsDid(db)],
    ['voicemail_users.conf', renderVoicemail(db)],
    ['queues_members.conf', renderQueues(db)],
  ].filter(([name, body]) => writeIfChanged(name, body));

  const queueCount = Object.keys(db.queues ?? {}).length;
  const groupCount = Object.keys(db.ringGroups ?? {}).length;
  console.log(
    `Applied ${db.users.length} extension(s), ${groupCount} ring group(s), ${queueCount} queue(s).`,
  );

  if (written.length === 0) {
    console.log('Asterisk configuration already up to date.');
  } else {
    for (const [name] of written) console.log(`  wrote infra/asterisk/conf/${name}`);
    console.log('\nReload Asterisk to pick this up:  make reload');
  }
}

function cmdList() {
  const db = loadUsers();
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('EXT', 6) + pad('NAME', 22) + pad('ROLE', 8) + pad('GROUPS', 16) + 'QUEUES');
  for (const user of db.users) {
    console.log(
      pad(user.extension, 6) +
        pad(user.name, 22) +
        pad(user.role ?? 'agent', 8) +
        pad((user.groups ?? []).join(',') || '-', 16) +
        ((user.queues ?? []).map((q) => `${q.name}:${q.penalty ?? 0}`).join(',') || '-'),
    );
  }
}

function cmdAdd(args) {
  if (!args.ext) die('add requires --ext');
  if (!args.name) die('add requires --name');

  const db = loadUsers();
  if (db.users.some((u) => String(u.extension) === String(args.ext))) {
    die(`extension ${args.ext} already exists`);
  }

  const queues = args.queues
    ? String(args.queues)
        .split(',')
        .filter(Boolean)
        .map((token) => {
          const [name, penalty] = token.split(':');
          return { name, penalty: Number(penalty ?? 0) };
        })
    : [];

  db.users.push({
    extension: String(args.ext),
    name: String(args.name),
    role: args.role ? String(args.role) : 'agent',
    groups: args.groups ? String(args.groups).split(',').filter(Boolean) : [],
    queues,
    ...(args.email ? { email: String(args.email) } : {}),
    ...(args.did ? { did: String(args.did) } : {}),
    ...(args.password ? { password: String(args.password) } : {}),
  });

  db.users.sort((a, b) => String(a.extension).localeCompare(String(b.extension)));
  validate(db);
  normalise(db);
  saveUsers(db);
  console.log(`Added extension ${args.ext} (${args.name}).`);
  cmdApply();
}

function cmdRemove(args) {
  if (!args.ext) die('remove requires --ext');
  const db = loadUsers();
  const before = db.users.length;
  db.users = db.users.filter((u) => String(u.extension) !== String(args.ext));
  if (db.users.length === before) die(`extension ${args.ext} not found`);
  saveUsers(db);
  console.log(`Removed extension ${args.ext}.`);
  console.log('Note: their voicemail spool is left in place; delete it manually if wanted.');
  cmdApply();
}

function cmdPasswd(args) {
  if (!args.ext) die('passwd requires --ext');
  const db = loadUsers();
  const user = db.users.find((u) => String(u.extension) === String(args.ext));
  if (!user) die(`extension ${args.ext} not found`);

  const plain = args.password ? String(args.password) : randomSecret(9);
  user.password = hashPassword(plain);
  saveUsers(db);
  console.log(`New web password for extension ${args.ext}: ${plain}`);

  if (args['sip'] === true) {
    user.sipPassword = randomSecret();
    saveUsers(db);
    console.log('SIP secret rotated — the user must sign out and back in.');
    cmdApply();
  }
}

function cmdInit() {
  if (existsSync(USERS_FILE)) {
    console.log('config/users.json already exists; leaving it alone.');
    return;
  }
  const example = JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));
  delete example.$comment;
  saveUsers(example);
  console.log('Created config/users.json from the example.');
  cmdApply();
}

// --- entry -----------------------------------------------------------------
const [, , command = 'apply', ...rest] = process.argv;
const args = parseArgs(rest);

switch (command) {
  case 'apply':
    cmdApply();
    break;
  case 'init':
    cmdInit();
    break;
  case 'list':
    cmdList();
    break;
  case 'add':
    cmdAdd(args);
    break;
  case 'remove':
    cmdRemove(args);
    break;
  case 'passwd':
    cmdPasswd(args);
    break;
  default:
    die(`unknown command "${command}" (apply | init | list | add | remove | passwd)`);
}
