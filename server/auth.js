const crypto = require('node:crypto');

// Secret for signing session tokens. Set SESSION_SECRET in production.
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signToken(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// Express middleware: attaches req.user ({id, role}) if a valid Bearer token is present.
function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const data = verifyToken(token);
  req.user = data ? { id: data.id, role: data.role } : null;
  next();
}

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (role && req.user.role !== role) {
      return res.status(403).json({ error: `This action is for ${role}s.` });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, signToken, authenticate, requireAuth };
