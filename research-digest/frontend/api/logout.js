// Vercel Serverless Function: POST /api/logout
module.exports = (req, res) => {
  res.setHeader('Set-Cookie', [
    'digest-auth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    'digest-admin=; Path=/; Secure; SameSite=Strict; Max-Age=0'
  ]);
  res.status(200).json({ ok: true });
};
