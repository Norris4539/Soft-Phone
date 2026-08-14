/** Environment configuration, read once and validated at boot. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set (see .env.example)`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const jwtSecret = optional('JWT_SECRET', '');
if (!jwtSecret) {
  throw new Error('JWT_SECRET must be set. Generate one with: openssl rand -hex 32');
}
// A shipped default secret means anyone who has read the repository can mint
// an admin token, so refuse to start with the placeholder still in place.
if (jwtSecret.startsWith('change-this') || jwtSecret === 'dev-insecure-secret-change-me') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is still the example value; generate a real one before deploying');
  }
  console.warn('[config] JWT_SECRET is the example value — fine for local dev, not for deployment');
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),

  publicHostname: optional('PUBLIC_HOSTNAME', 'localhost'),
  sipDomain: optional('ASTERISK_SIP_DOMAIN', optional('PUBLIC_HOSTNAME', 'localhost')),
  mainDid: optional('MAIN_DID', ''),

  usersFile: optional('USERS_FILE', '../config/users.json'),

  jwt: {
    secret: jwtSecret,
    ttl: optional('JWT_TTL', '12h'),
  },

  ari: {
    url: optional('ARI_URL', 'http://asterisk:8088/ari'),
    username: required('ARI_USERNAME'),
    password: required('ARI_PASSWORD'),
    app: optional('ARI_APP', 'switchboard'),
  },

  ami: {
    host: optional('AMI_HOST', 'asterisk'),
    port: Number(optional('AMI_PORT', '5038')),
    username: required('AMI_USERNAME'),
    password: required('AMI_PASSWORD'),
  },

  turn: {
    // Comma-separated so an operator can add a managed TURN service alongside
    // the bundled coturn without a code change.
    urls: optional('TURN_URLS', `turn:${optional('PUBLIC_HOSTNAME', 'localhost')}:3478`)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    username: optional('TURN_USERNAME', ''),
    password: optional('TURN_PASSWORD', ''),
  },

  /** Where browsers open the SIP WebSocket. Always WSS — browsers require it. */
  get sipWebsocketUrl(): string {
    return optional('SIP_WS_URL', `wss://${optional('PUBLIC_HOSTNAME', 'localhost')}:8089/ws`);
  },
} as const;

export type Config = typeof config;
