function getSessionCookieName(isProd) {
  return isProd ? '__Host-session' : 'connect.sid';
}

function buildSessionOptions({ isProd, secret, store }) {
  return {
    name: getSessionCookieName(isProd),
    secret,
    resave: false,
    saveUninitialized: false,
    store,
    cookie: {
      httpOnly: true,
      sameSite: isProd ? 'strict' : 'lax',
      secure: isProd,
      path: '/',
      maxAge: 1000 * 60 * 60 * 12
    }
  };
}

module.exports = {
  buildSessionOptions,
  getSessionCookieName
};
