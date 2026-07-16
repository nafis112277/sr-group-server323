import jwt from 'jsonwebtoken';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signUserToken(user) {
  return jwt.sign({ email: user.email, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
}

export function signAdminToken(admin) {
  return jwt.sign(
    { role: 'admin', adminId: admin.id, adminRole: admin.role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function requireUser(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'user') throw new Error('wrong role');
    req.userEmail = payload.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

export function requireAdmin(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not signed in as admin.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('wrong role');
    req.adminId = payload.adminId;
    req.adminRole = payload.adminRole;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Admin session expired. Please log in again.' });
  }
}

export function requireSuperAdmin(req, res, next) {
  if (req.adminRole !== 'super_admin') {
    return res.status(403).json({ error: 'Only super admins can do this.' });
  }
  next();
}
