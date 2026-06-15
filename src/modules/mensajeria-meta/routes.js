function registerMensajeriaMetaRoutes(app, deps) {
  const { requireAuth, requirePermission } = deps;

  app.get('/mensajeria-meta', requireAuth, requirePermission('mensajeria_meta', 'view'), (req, res) => {
    res.render('mensajeria-meta/index', {
      lang: res.locals.lang,
      currentModule: 'mensajeria_meta',
      activeTab: 'home',
      moduleTabs: buildMensajeriaMetaTabs('home')
    });
  });
}

function buildMensajeriaMetaTabs(active) {
  return [
    { key: 'home', label: 'Menu', href: '/mensajeria-meta' },
    { key: 'whatsapp', label: 'WhatsApp', href: '/whatsapp' },
    { key: 'meta_inbox', label: 'Meta Inbox', href: '/meta-inbox' },
    { key: 'whatsapp_settings', label: 'Config. WhatsApp', href: '/whatsapp/settings' },
    { key: 'meta_settings', label: 'Config. Meta', href: '/meta-inbox/settings' }
  ].map((tab) => ({ ...tab, active: tab.key === active }));
}

module.exports = {
  registerMensajeriaMetaRoutes,
  buildMensajeriaMetaTabs
};
