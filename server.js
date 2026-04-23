require('dotenv').config();
const MASTER_USER = process.env.MASTER_USER || null;
const MASTER_PASS = process.env.MASTER_PASS || null;
const SESSION_SECRET = process.env.SESSION_SECRET || null;
const FILE_TOKEN_SECRET_ENV = process.env.FILE_TOKEN_SECRET || null;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const ejs = require('ejs');
const multer = require('multer');
const crypto = require('crypto');
const csrf = require('csurf');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const XLSX = require('xlsx');
const https = require('https');
const http = require('http');
const { applySecurityHeaders } = require('./src/core/security-headers');
const { buildSessionOptions, getSessionCookieName } = require('./src/core/session-config');
const { createRateLimiter } = require('./src/core/rate-limiter');
const { registerAuthRoutes } = require('./src/modules/auth/routes');
const { registerCompanyRoutes } = require('./src/modules/companies/routes');
const { registerPackageRoutes } = require('./src/modules/packages/routes');
const { registerCustomerRoutes } = require('./src/modules/customers/routes');
const { registerCarrierReceptionRoutes } = require('./src/modules/carrier-reception/routes');
const { registerInventoryRoutes } = require('./src/modules/inventory/routes');
const { registerAccountingRoutes } = require('./src/modules/accounting/routes');
const { registerLogisticsRoutes } = require('./src/modules/logistics/routes');
const { registerInvoiceRoutes } = require('./src/modules/invoices/routes');
const { registerAgendaMedicaRoutes } = require('./src/modules/agenda-medica/routes');
const { registerHrRoutes } = require('./src/modules/hr/routes');
const { registerUserRoutes } = require('./src/modules/users/routes');
const { registerAuditRoutes } = require('./src/modules/audit/routes');
const { registerMasterActivitiesRoutes } = require('./src/modules/master-activities/routes');
const { registerMasterRoutes } = require('./src/modules/master/routes');
const { registerMasterAuthRoutes } = require('./src/modules/master-auth/routes');
const { registerMasterCompanyRoutes } = require('./src/modules/master-companies/routes');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const ACTIVE_SESSION_SECRET = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const FILE_TOKEN_SECRET = FILE_TOKEN_SECRET_ENV || ACTIVE_SESSION_SECRET;
const SESSION_COOKIE_NAME = getSessionCookieName(IS_PROD);

const app = express();
const PORT = process.env.PORT || 3000;
const SHOULD_AUTO_SELECT_PORT = !process.env.PORT && !IS_PROD;
const MAX_PORT_RETRIES = 10;
const DB_PATH = path.join(__dirname, 'data', 'app.db');
const GLOBAL_DOCK_PARTIAL_PATH = path.join(__dirname, 'views', 'partials', 'global-dock.ejs');
const DESIGN_SYSTEM_ASSETS = [
  '<link rel="stylesheet" href="/css/theme.css" data-design-system-asset />',
  '<link rel="stylesheet" href="/css/layout.css" data-design-system-asset />',
  '<link rel="stylesheet" href="/css/components.css" data-design-system-asset />'
];
const UPLOAD_ROOT = path.join(__dirname, 'data', 'uploads');
const CUSCAR_BASE_CATALOG_PATH = path.join(__dirname, 'data', 'cuscar-catalogs.json');
const CUSCAR_CATALOGS = {
  countries: {
    type: 'countries',
    table: 'cuscar_countries',
    titleKey: 'cuscar.catalog.countries.title',
    subtitleKey: 'cuscar.catalog.countries.subtitle',
    scope: 'mixed',
    allowCreate: false,
    seedKey: 'countries',
    order: 10
  },
  customs_offices: {
    type: 'customs_offices',
    table: 'cuscar_customs_offices',
    titleKey: 'cuscar.catalog.customs_offices.title',
    subtitleKey: 'cuscar.catalog.customs_offices.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'customs_offices',
    order: 20
  },
  airports: {
    type: 'airports',
    table: 'cuscar_airports',
    titleKey: 'cuscar.catalog.airports.title',
    subtitleKey: 'cuscar.catalog.airports.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'airports',
    order: 30
  },
  ports: {
    type: 'ports',
    table: 'cuscar_ports',
    titleKey: 'cuscar.catalog.ports.title',
    subtitleKey: 'cuscar.catalog.ports.subtitle',
    scope: 'mixed',
    allowCreate: false,
    seedKey: 'ports',
    order: 40
  },
  transport_modes: {
    type: 'transport_modes',
    table: 'cuscar_transport_modes',
    titleKey: 'cuscar.catalog.transport_modes.title',
    subtitleKey: 'cuscar.catalog.transport_modes.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'transport_modes',
    order: 50
  },
  transport_means: {
    type: 'transport_means',
    table: 'cuscar_transport_means',
    titleKey: 'cuscar.catalog.transport_means.title',
    subtitleKey: 'cuscar.catalog.transport_means.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'transport_means',
    order: 60
  },
  message_types: {
    type: 'message_types',
    table: 'cuscar_message_types',
    titleKey: 'cuscar.catalog.message_types.title',
    subtitleKey: 'cuscar.catalog.message_types.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'message_types',
    order: 70
  },
  message_functions: {
    type: 'message_functions',
    table: 'cuscar_message_functions',
    titleKey: 'cuscar.catalog.message_functions.title',
    subtitleKey: 'cuscar.catalog.message_functions.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'message_functions',
    order: 80
  },
  reference_qualifiers: {
    type: 'reference_qualifiers',
    table: 'cuscar_reference_qualifiers',
    titleKey: 'cuscar.catalog.reference_qualifiers.title',
    subtitleKey: 'cuscar.catalog.reference_qualifiers.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'reference_qualifiers',
    order: 90
  },
  message_responsibles: {
    type: 'message_responsibles',
    table: 'cuscar_message_responsibles',
    titleKey: 'cuscar.catalog.message_responsibles.title',
    subtitleKey: 'cuscar.catalog.message_responsibles.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'message_responsibles',
    order: 100
  },
  transport_id_agencies: {
    type: 'transport_id_agencies',
    table: 'cuscar_transport_id_agencies',
    titleKey: 'cuscar.catalog.transport_id_agencies.title',
    subtitleKey: 'cuscar.catalog.transport_id_agencies.subtitle',
    scope: 'global',
    allowCreate: false,
    seedKey: 'transport_id_agencies',
    order: 110
  },
  transporters: {
    type: 'transporters',
    table: 'cuscar_transporters',
    titleKey: 'cuscar.catalog.transporters.title',
    subtitleKey: 'cuscar.catalog.transporters.subtitle',
    scope: 'company',
    allowCreate: true,
    seedKey: 'transporters',
    seedScope: 'company',
    order: 120
  },
  airlines: {
    type: 'airlines',
    table: 'cuscar_airlines',
    titleKey: 'cuscar.catalog.airlines.title',
    subtitleKey: 'cuscar.catalog.airlines.subtitle',
    scope: 'mixed',
    allowCreate: true,
    seedKey: 'airlines',
    order: 130
  },
  consignatarios: {
    type: 'consignatarios',
    table: 'cuscar_consignatarios',
    titleKey: 'cuscar.catalog.consignatarios.title',
    subtitleKey: 'cuscar.catalog.consignatarios.subtitle',
    scope: 'company',
    allowCreate: true,
    order: 140
  },
  remitentes: {
    type: 'remitentes',
    table: 'cuscar_remitentes',
    titleKey: 'cuscar.catalog.remitentes.title',
    subtitleKey: 'cuscar.catalog.remitentes.subtitle',
    scope: 'company',
    allowCreate: true,
    order: 150
  },
  package_types: {
    type: 'package_types',
    table: 'cuscar_package_types',
    titleKey: 'cuscar.catalog.package_types.title',
    subtitleKey: 'cuscar.catalog.package_types.subtitle',
    scope: 'mixed',
    allowCreate: false,
    seedKey: 'package_types',
    order: 160
  },
  units: {
    type: 'units',
    table: 'cuscar_units',
    titleKey: 'cuscar.catalog.units.title',
    subtitleKey: 'cuscar.catalog.units.subtitle',
    scope: 'mixed',
    allowCreate: false,
    seedKey: 'units',
    order: 170
  }
};
const CUSCAR_CATALOG_LIST = Object.values(CUSCAR_CATALOGS).sort((a, b) => (a.order || 0) - (b.order || 0));
const DEFAULT_LANG = 'es';
const SUPPORTED_LANGS = { es: 'EspaÃ±ol', en: 'English' };
let isStartingUp = true;
const SAT_PORTAL_URL = 'https://portal.sat.gob.gt/portal/consulta-cui-nit/';
const PACKAGE_STATUSES = [
  'Recibido en bodega USA',
  'Pendiente de factura',
  'Factura subida',
  'Cargado a vuelo',
  'En trÃ¡nsito',
  'En aduana de destino',
  'En proceso de aduana',
  'Liberado',
  'En entrega',
  'Entregado'
];
const PACKAGE_STATUS_launcher_COLORS = {
  'Recibido en bodega USA': '#1d4f8a',
  'Pendiente de factura': '#8a5b00',
  'Factura subida': '#4338ca',
  'Cargado a vuelo': '#0f766e',
  'En trÃ¡nsito': '#075985',
  'En aduana de destino': '#9f1239',
  'En proceso de aduana': '#9f1239',
  'Liberado': '#0e7490',
  'En entrega': '#166534',
  'Entregado': '#166534'
};
const APPOINTMENT_STATUSES = ['pendiente', 'confirmada', 'atendida', 'cancelada'];
const APPOINTMENT_DEFAULT_DURATION = 30;
const URGENT_STUCK_DAYS = 7;
const URGENT_INVOICE_DAYS = 5;
const URGENT_CUSTOMS_DAYS = 5;
const FILE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24;
const INVOICE_UPLOAD_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;
if (!SESSION_SECRET) {
  console.warn('[config] SESSION_SECRET no configurado. Use una variable de entorno segura.');
}
if (!MASTER_USER || !MASTER_PASS) {
  console.warn('[config] MASTER_USER/MASTER_PASS no configurados. El login master quedara deshabilitado.');
}
if (!process.env.FILE_TOKEN_SECRET) {
  console.warn('[config] FILE_TOKEN_SECRET no configurado. Use una variable de entorno segura.');
}
function readJsonFile(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  return JSON.parse(raw);
}

const MOJIBAKE_PATTERN = /Ãƒ.|Ã‚|Ã¢â‚¬|Ã¢â‚¬â„¢|Ã¢â‚¬Å“|Ã¢â‚¬Â|Ã¢â‚¬Â¦/;

function findMojibake(value, pathSegments) {
  if (typeof value === 'string') {
    if (MOJIBAKE_PATTERN.test(value)) {
      return { path: pathSegments.join('.'), sample: value.slice(0, 80) };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findMojibake(value[i], pathSegments.concat(String(i)));
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const hit = findMojibake(val, pathSegments.concat(key));
      if (hit) return hit;
    }
  }
  return null;
}

function assertNoMojibake(localeData, label) {
  const hit = findMojibake(localeData, []);
  if (hit) {
    throw new Error(`[i18n] Texto con codificacion corrupta en ${label}: ${hit.path} = "${hit.sample}"`);
  }
}

function stripBomIfPresent(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(3);
  const bytesRead = fs.readSync(fd, buffer, 0, 3, 0);
  fs.closeSync(fd);
  const hasBom = bytesRead >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  if (!hasBom) return;
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  fs.writeFileSync(filePath, raw, 'utf8');
  console.warn(`[i18n] BOM removido de ${filePath}.`);
}

const LOCALES_DIR = path.join(__dirname, 'locales');
try {
  const localeFiles = fs.readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json'));
  localeFiles.forEach((name) => stripBomIfPresent(path.join(LOCALES_DIR, name)));
} catch (err) {
  console.warn('[i18n] No se pudo validar BOM en locales:', err.message);
}

const TRANSLATIONS = {
  es: readJsonFile(path.join(__dirname, 'locales', 'es.json')),
  en: readJsonFile(path.join(__dirname, 'locales', 'en.json'))
};
Object.entries(TRANSLATIONS).forEach(([lang, data]) => {
  assertNoMojibake(data, `locales/${lang}.json`);
});
const CUSTOMER_DOCUMENT_TYPES = ['NIT', 'CF', 'DPI'];
const PAYMENT_METHODS = ['Efectivo', 'Transferencia', 'Tarjeta'];
const COMMUNICATION_TYPES = ['Whatsapp', 'Correo', 'Llamada'];
const DEFAULT_CURRENCIES = ['GTQ', 'USD'];
const COMPANY_COUNTRIES = ['Guatemala', 'United States'];
const COSTING_METHODS = ['average', 'fifo'];


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(applySecurityHeaders({ isProd: IS_PROD }));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session(
    buildSessionOptions({
      isProd: IS_PROD,
      secret: ACTIVE_SESSION_SECRET,
      store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') })
    })
  )
);

const csrfProtection = csrf();
const csrfMiddleware = (req, res, next) => {
  return csrfProtection(req, res, (err) => {
    if (err) return next(err);
    res.locals.csrfToken = req.csrfToken();
    return next();
  });
};
app.use((req, res, next) => {
  if (req.is('multipart/form-data')) return next();
  return csrfMiddleware(req, res, next);
});

const SAT_ENV = (process.env.SAT_ENV || 'simulation').toLowerCase();
const SAT_ENDPOINT_TEST = process.env.SAT_ENDPOINT_TEST || '';
const SAT_ENDPOINT_PROD = process.env.SAT_ENDPOINT_PROD || '';

app.use((req, res, next) => {
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }
  next();
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.company = req.session.company || null;
  const hasMaster = Boolean(req.session && req.session.master);
  const hasCompanyUser = Boolean(req.session && req.session.user);
  res.locals.isMaster = hasMaster && !hasCompanyUser;
  next();
});

app.use((req, res, next) => {
  const map = req.session ? req.session.permissionMap : null;
  res.locals.permissionMap = map || null;
  res.locals.can = (moduleCode, actionCode) => hasPermission(map, moduleCode, actionCode);
  next();
});

app.use((req, res, next) => {
  if (req.session && !req.session.lang) {
    req.session.lang = DEFAULT_LANG;
  }
  const sessionLang = req.session ? req.session.lang : null;
  const lang = SUPPORTED_LANGS[sessionLang] ? sessionLang : DEFAULT_LANG;
  res.locals.lang = lang;
  res.locals.languages = SUPPORTED_LANGS;
  res.locals.t = (key, vars) => {
    const primary = TRANSLATIONS[lang] || {};
    const fallback = TRANSLATIONS[DEFAULT_LANG] || {};
    let value = primary[key] || fallback[key];
    if (!value) return key;
    if (vars) {
      value = value.replace(/\{(\w+)\}/g, (match, token) =>
        Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match
      );
    }
    return value;
  };
  next();
});

app.use((req, res, next) => {
  res.locals.packagesNav = 'list';
  next();
});

function normalizeViewName(view) {
  return String(view || '').replace(/\\/g, '/');
}

function shouldInjectGlobalDesignAssets(view, html) {
  if (typeof html !== 'string' || !/<\/head>/i.test(html)) return false;
  if (!html.includes('/styles.css')) return false;
  const viewName = normalizeViewName(view);
  const printableViews = new Set([
    'package-label',
    'package-label-batch',
    'package-receipt',
    'awb-print',
    'awb-pdf-view',
    'rrhh/employee-print',
    'rrhh/contract-print',
    'rrhh/record-print'
  ]);
  return !printableViews.has(viewName);
}

function injectGlobalDesignAssets(view, html) {
  if (!shouldInjectGlobalDesignAssets(view, html)) return html;
  const missingAssets = DESIGN_SYSTEM_ASSETS.filter((tag) => {
    const hrefMatch = tag.match(/href="([^"]+)"/);
    return hrefMatch && !html.includes(hrefMatch[1]);
  });
  if (!missingAssets.length) return html;
  return html.replace(/<\/head>/i, `${missingAssets.join('\n')}\n</head>`);
}

function shouldInjectGlobalDock(req, view, html) {
  if (!req.session || !req.session.user || !req.session.company) return false;
  if (typeof html !== 'string' || !/<\/body>/i.test(html)) return false;
  if (
    html.includes('data-global-dock-asset') ||
    html.includes('data-global-dock-mount') ||
    html.includes('data-global-dock-root') ||
    html.includes('id="workspace-dock"')
  ) {
    return false;
  }
  const viewName = normalizeViewName(view);
  if (viewName === 'workspace' || viewName.endsWith('/workspace')) return false;
  return true;
}

function injectGlobalDockMarkup(html, partialHtml) {
  if (!partialHtml) return html;
  const styleTag = '<link rel="stylesheet" href="/css/global-dock.css" data-global-dock-asset />';
  let output = html;

  if (!output.includes('/css/global-dock.css') && /<\/head>/i.test(output)) {
    output = output.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }
  if (!output.includes('data-global-dock-mount')) {
    output = output.replace(/<\/body>/i, `${partialHtml}\n</body>`);
  }

  return output;
}

function buildGlobalDockBootstrap(req, res, payload) {
  const labels = buildWorkspaceLabels(res.locals.lang);
  return JSON.stringify({
    ok: true,
    state: payload.workspaceState,
    companyBrand: payload.companyBrand,
    icons: payload.icons,
    currentPath: req.originalUrl || req.path || '/',
    labels: {
      modulesTitle: labels.modulesTitle,
      noModules: labels.noModules,
      showDock: res.locals.lang === 'en' ? 'Show dock' : 'Mostrar dock',
      hideDock: res.locals.lang === 'en' ? 'Hide dock' : 'Ocultar dock'
    }
  }).replace(/</g, '\\u003c');
}

function renderGlobalDockPartial(req, res, callback) {
  buildWorkspaceResponse(req, res, (err, payload) => {
    if (err || !payload || !payload.workspaceState) {
      callback(null, '');
      return;
    }
    const settings = payload.workspaceState.settings || {};
    if (settings.dockEnabled === false) {
      callback(null, '');
      return;
    }
    ejs.renderFile(
      GLOBAL_DOCK_PARTIAL_PATH,
      { globalDockBootstrap: buildGlobalDockBootstrap(req, res, payload) },
      {},
      (renderErr, partialHtml) => callback(renderErr || null, partialHtml || '')
    );
  });
}

app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, options, callback) => {
    let renderOptions = options;
    let renderCallback = callback;
    if (typeof renderOptions === 'function') {
      renderCallback = renderOptions;
      renderOptions = undefined;
    }

    return originalRender(view, renderOptions, (err, html) => {
      if (err) {
        if (renderCallback) return renderCallback(err);
        return next(err);
      }

      const htmlWithDesignSystem = injectGlobalDesignAssets(view, html);

      if (!shouldInjectGlobalDock(req, view, htmlWithDesignSystem)) {
        if (renderCallback) return renderCallback(null, htmlWithDesignSystem);
        return res.send(htmlWithDesignSystem);
      }

      return renderGlobalDockPartial(req, res, (dockErr, partialHtml) => {
        if (dockErr) {
          if (renderCallback) return renderCallback(dockErr);
          return next(dockErr);
        }
        const renderedHtml = injectGlobalDockMarkup(htmlWithDesignSystem, partialHtml);
        if (renderCallback) return renderCallback(null, renderedHtml);
        return res.send(renderedHtml);
      });
    });
  };
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const PACKAGE_UPLOAD_ROOT = path.join(UPLOAD_ROOT, 'packages');
const PACKAGE_PHOTOS_DIR = path.join(PACKAGE_UPLOAD_ROOT, 'photos');
const PACKAGE_INVOICES_DIR = path.join(PACKAGE_UPLOAD_ROOT, 'invoices');
const COMPANY_UPLOAD_ROOT = path.join(UPLOAD_ROOT, 'companies');
const COMPANY_LOGOS_DIR = path.join(COMPANY_UPLOAD_ROOT, 'logos');

function ensureUploadDirs() {
  [
    PACKAGE_UPLOAD_ROOT,
    PACKAGE_PHOTOS_DIR,
    PACKAGE_INVOICES_DIR,
    COMPANY_UPLOAD_ROOT,
    COMPANY_LOGOS_DIR
  ].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

ensureUploadDirs();

const rateLimiter = createRateLimiter({
  sweepMs: 1000 * 60 * 10,
  maxIdleMs: 1000 * 60 * 30
});

const trackingRateLimit = new Map();
const TRACKING_LIMIT_WINDOW_MS = 60 * 1000;
const TRACKING_LIMIT_MAX = 8;

const customerPortalRateLimit = new Map();
const CUSTOMER_PORTAL_WINDOW_MS = 60 * 1000;
const CUSTOMER_PORTAL_MAX = 6;
const loginRateLimit = new Map();
const masterLoginRateLimit = new Map();
const AUTH_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_MAX = 10;
const MASTER_LOGIN_LIMIT_MAX = 6;

const packageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const targetDir = file.fieldname === 'invoice_file' ? PACKAGE_INVOICES_DIR : PACKAGE_PHOTOS_DIR;
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const token = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${token}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos') {
      return cb(null, file.mimetype && file.mimetype.startsWith('image/'));
    }
    if (file.fieldname === 'invoice_file') {
      const allowed =
        (file.mimetype && file.mimetype.startsWith('image/')) ||
        file.mimetype === 'application/pdf';
      return cb(null, allowed);
    }
    return cb(null, false);
  }
});

const companyLogoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, COMPANY_LOGOS_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const token = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${token}${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    return cb(null, false);
  }
});

const db = new sqlite3.Database(DB_PATH);
if (sqlite3.Statement && sqlite3.Statement.prototype && sqlite3.Statement.prototype.emit) {
  const originalStmtEmit = sqlite3.Statement.prototype.emit;
  sqlite3.Statement.prototype.emit = function (event, ...args) {
    if (event === 'error') {
      console.error('[sqlite] statement error', args[0]);
      return true;
    }
    return originalStmtEmit.call(this, event, ...args);
  };
}

let transactionQueue = Promise.resolve();

function enqueueDbTransaction(run) {
  transactionQueue = transactionQueue
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            resolve();
          };
          try {
            run(finish);
          } catch (err) {
            finish();
          }
        })
    );
}

function commitTransaction(finish, callback) {
  db.run('COMMIT', (err) => {
    finish();
    if (callback) callback(err);
  });
}

function rollbackTransaction(finish, callback) {
  db.run('ROLLBACK', (err) => {
    finish();
    if (callback) callback(err);
  });
}

function isDuplicateColumnError(err) {
  if (!err || !err.message) return false;
  const message = String(err.message).toLowerCase();
  return message.includes('duplicate column') || message.includes('already exists');
}

function isUniqueConstraintError(err) {
  if (!err) return false;
  const message = String(err.message || '').toLowerCase();
  return err.code === 'SQLITE_CONSTRAINT' || message.includes('unique constraint') || message.includes('constraint failed');
}

function escapeSqlIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return normalized;
}

function serializeMigrationDetails(details) {
  if (details === undefined) return null;
  try {
    return JSON.stringify(details);
  } catch (err) {
    return JSON.stringify({ serialization_error: err.message || String(err) });
  }
}

function ensureMigrationLogTable() {
  db.run(
    `CREATE TABLE IF NOT EXISTS migration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      scope TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) {
        console.error('[migration] failed to initialize migration_events table', err);
      }
    }
  );
}

function logMigrationEvent(level, scope, message, details) {
  const normalizedLevel = String(level || 'info').toLowerCase();
  const logger = normalizedLevel === 'error' ? console.error : normalizedLevel === 'warn' ? console.warn : console.log;
  logger(`[migration][${scope}] ${message}`);
  if (details !== undefined) {
    logger(details);
  }
  db.run(
    'INSERT INTO migration_events (level, scope, message, details) VALUES (?, ?, ?, ?)',
    [normalizedLevel, String(scope || 'general'), String(message || ''), serializeMigrationDetails(details)],
    (err) => {
      if (err) {
        console.error('[migration] failed to write migration event', err);
      }
    }
  );
}

function tableExists(table, callback) {
  db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
    (err, row) => {
      if (err || !row) return callback(false);
      return callback(true);
    }
  );
}

function ensureColumn(table, column, typeDef) {
  tableExists(table, (exists) => {
    if (!exists) return;
    db.all(`PRAGMA table_info(${table})`, (err, columns) => {
      if (err || !columns) return;
      const hasColumn = columns.some((col) => col.name === column);
      if (!hasColumn) {
        const normalized = normalizeAddColumnType(typeDef);
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${normalized.addDef}`, (alterErr) => {
          if (alterErr && !isDuplicateColumnError(alterErr)) {
            console.warn(`Failed adding column ${column} to ${table}:`, alterErr.message || alterErr);
            return;
          }
          if (normalized.needsBackfill) {
            db.run(
              `UPDATE ${table} SET ${column} = CURRENT_TIMESTAMP WHERE ${column} IS NULL`,
              () => {}
            );
            ensureCreatedAtTrigger(table, column);
          }
        });
      }
    });
  });
}

function ensureColumnsOnTable(table, columns, done) {
  if (!table) {
    if (done) done();
    return;
  }
  db.all(`PRAGMA table_info(${table})`, (err, existing) => {
    if (err || !existing) {
      if (done) done();
      return;
    }
    const existingNames = new Set(existing.map((col) => col.name));
    const pending = columns.filter((col) => !existingNames.has(col.name));
    if (!pending.length) {
      if (done) done();
      return;
    }
    let remaining = pending.length;
    pending.forEach((col) => {
      const normalized = normalizeAddColumnType(col.type);
      db.run(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${normalized.addDef}`, (alterErr) => {
        if (alterErr && !isDuplicateColumnError(alterErr)) {
          console.warn(`Failed adding column ${col.name} to ${table}:`, alterErr.message || alterErr);
        } else if (normalized.needsBackfill) {
          db.run(
            `UPDATE ${table} SET ${col.name} = CURRENT_TIMESTAMP WHERE ${col.name} IS NULL`,
            () => {}
          );
          ensureCreatedAtTrigger(table, col.name);
        }
        remaining -= 1;
        if (remaining === 0 && done) done();
      });
    });
  });
}

function loadIndexMetadata(table, callback) {
  const safeTable = escapeSqlIdentifier(table);
  db.all(`PRAGMA index_list(${safeTable})`, (err, indexes) => {
    if (err || !indexes || indexes.length === 0) {
      callback(err, []);
      return;
    }
    const metadata = [];
    let remaining = indexes.length;
    indexes.forEach((idx) => {
      const safeIndexName = String(idx.name || '').replace(/'/g, "''");
      db.all(`PRAGMA index_info('${safeIndexName}')`, (infoErr, columns) => {
        metadata.push({
          ...idx,
          columns: infoErr || !columns ? [] : columns.map((col) => col.name)
        });
        remaining -= 1;
        if (remaining === 0) {
          callback(null, metadata);
        }
      });
    });
  });
}

function sameColumnSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function findDuplicateGroups(table, columns, options, callback) {
  const safeTable = escapeSqlIdentifier(table);
  const config = options || {};
  const safeColumns = columns.map((column) => escapeSqlIdentifier(column));
  const selectColumns = safeColumns.join(', ');
  const whereClause = config.where ? `WHERE ${config.where}` : '';
  const limit = Number.isInteger(config.limit) && config.limit > 0 ? config.limit : 5;
  db.all(
    `SELECT ${selectColumns}, COUNT(*) AS total
     FROM ${safeTable}
     ${whereClause}
     GROUP BY ${selectColumns}
     HAVING total > 1
     LIMIT ${limit}`,
    (err, rows) => {
      callback(err, rows || []);
    }
  );
}

function dropIndexesSequentially(indexes, done) {
  if (!indexes || indexes.length === 0) {
    if (done) done();
    return;
  }
  const [current, ...rest] = indexes;
  const safeIndexName = escapeSqlIdentifier(current.name);
  db.run(`DROP INDEX IF EXISTS ${safeIndexName}`, (err) => {
    if (err) {
      logMigrationEvent('warn', 'indexes', 'No se pudo eliminar un indice heredado en una migracion segura.', {
        index: current.name,
        error: err.message || String(err)
      });
    }
    dropIndexesSequentially(rest, done);
  });
}

function ensureUniqueIndexSafely(table, columns, createSql, options, callback) {
  const config = options || {};
  const scope = config.scope || `${table}_${columns.join('_')}`;
  const conflictColumnSets = Array.isArray(config.conflictColumnSets) ? config.conflictColumnSets : [];
  tableExists(table, (exists) => {
    if (!exists) {
      if (callback) callback(false);
      return;
    }
    loadIndexMetadata(table, (err, indexes) => {
      if (err) {
        logMigrationEvent('warn', scope, 'No se pudo inspeccionar los indices existentes antes de aplicar una migracion segura.', {
          table,
          error: err.message || String(err)
        });
        if (callback) callback(false);
        return;
      }
      const desiredIndex = indexes.find((idx) => idx.unique && sameColumnSet(idx.columns, columns));
      if (desiredIndex) {
        if (callback) callback(true);
        return;
      }
      const conflictingIndexes = indexes.filter((idx) =>
        idx.unique &&
        idx.origin === 'c' &&
        conflictColumnSets.some((candidate) => sameColumnSet(idx.columns, candidate))
      );
      dropIndexesSequentially(conflictingIndexes, () => {
        findDuplicateGroups(table, columns, { where: config.where, limit: config.limit }, (dupErr, duplicates) => {
          if (dupErr) {
            logMigrationEvent('warn', scope, 'No se pudo validar duplicados antes de crear un indice unico.', {
              table,
              columns,
              error: dupErr.message || String(dupErr)
            });
            if (callback) callback(false);
            return;
          }
          if (duplicates.length > 0) {
            logMigrationEvent('warn', scope, 'Se omitio la creacion de un indice unico para no borrar ni reescribir datos existentes.', {
              table,
              columns,
              duplicates
            });
            if (config.fallbackSql) {
              db.run(config.fallbackSql, (fallbackErr) => {
                if (fallbackErr) {
                  logMigrationEvent('warn', scope, 'No se pudo crear el indice alterno no unico.', {
                    table,
                    columns,
                    error: fallbackErr.message || String(fallbackErr)
                  });
                }
                if (callback) callback(false);
              });
              return;
            }
            if (callback) callback(false);
            return;
          }
          db.run(createSql, (createErr) => {
            if (createErr) {
              logMigrationEvent(isUniqueConstraintError(createErr) ? 'warn' : 'error', scope, 'No se pudo crear el indice unico seguro.', {
                table,
                columns,
                error: createErr.message || String(createErr)
              });
              if (config.fallbackSql) {
                db.run(config.fallbackSql, () => {
                  if (callback) callback(false);
                });
                return;
              }
              if (callback) callback(false);
              return;
            }
            if (callback) callback(true);
          });
        });
      });
    });
  });
}


function normalizeAddColumnType(typeDef) {
  if (!typeDef) return { addDef: '', needsBackfill: false };
  const needsBackfill = /DEFAULT\s+CURRENT_TIMESTAMP/i.test(typeDef);
  if (!needsBackfill) return { addDef: typeDef, needsBackfill: false };
  const addDef = typeDef
    .replace(/DEFAULT\s+CURRENT_TIMESTAMP/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { addDef, needsBackfill: true };
}

function ensureCreatedAtTrigger(table, column) {
  const triggerName = `trg_${table}_${column}_default`;
  db.run(
    `CREATE TRIGGER IF NOT EXISTS ${triggerName}` +
    ` AFTER INSERT ON ${table}` +
    ` FOR EACH ROW` +
    ` WHEN NEW.${column} IS NULL` +
    ` BEGIN` +
    ` UPDATE ${table} SET ${column} = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;` +
    ` END;`
  );
}
function parseCurrencyList(value, fallbackCurrency) {
  if (Array.isArray(value)) return normalizeCurrencyList(value, fallbackCurrency);
  if (!value) return fallbackCurrency ? [fallbackCurrency] : [];
  return normalizeCurrencyList(String(value).split(/[,;\s]+/), fallbackCurrency);
}

function normalizeCurrencyList(list, fallbackCurrency) {
  const normalized = (list || [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  if (fallbackCurrency) {
    const base = String(fallbackCurrency).trim().toUpperCase();
    if (base && !unique.includes(base)) unique.unshift(base);
  }
  return unique;
}

function formatIsoDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function resolveCompanyActiveWindow({ activeMode, activeFrom, activeUntil }) {
  const modeRaw = String(activeMode || '').trim().toLowerCase();
  const mode = modeRaw || 'contract';
  if (mode === 'indefinite' || mode === 'indefinido') {
    return { activeMode: 'indefinite', activeFrom: null, activeUntil: null };
  }
  if (mode === 'trial' || mode === 'prueba') {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 7);
    return {
      activeMode: 'trial',
      activeFrom: formatIsoDate(today),
      activeUntil: formatIsoDate(end)
    };
  }
  const resolvedFrom = activeFrom || null;
  const resolvedUntil = activeUntil || null;
  if (resolvedFrom && resolvedUntil && resolvedFrom > resolvedUntil) {
    return { invalid: true };
  }
  return { activeMode: 'contract', activeFrom: resolvedFrom, activeUntil: resolvedUntil };
}

function ensureCompanyAccountingColumns(done) {
  ensureColumnsOnTable('companies', [
    { name: 'country', type: 'TEXT' },
    { name: 'base_currency', type: 'TEXT' },
    { name: 'allowed_currencies', type: 'TEXT' },
    { name: 'tax_rate', type: 'REAL' },
    { name: 'tax_name', type: 'TEXT' },
    { name: 'tax_payable_account_id', type: 'INTEGER' },
    { name: 'tax_credit_account_id', type: 'INTEGER' },
    { name: 'costing_method', type: 'TEXT' },
    { name: 'multi_currency_enabled', type: 'INTEGER' },
    { name: 'accounting_method', type: 'TEXT' },
    { name: 'accounting_framework', type: 'TEXT' }
  ], done);
}


function applyCompanyDefaults() {
  db.run(
    `UPDATE companies
     SET base_currency = COALESCE(base_currency, currency, 'GTQ'),
         allowed_currencies = COALESCE(allowed_currencies, 'GTQ,USD'),
         multi_currency_enabled = COALESCE(multi_currency_enabled, 1),
         tax_rate = COALESCE(tax_rate, 12),
         tax_name = COALESCE(tax_name, 'IVA'),
         accounting_method = COALESCE(accounting_method, 'accrual'),
         accounting_framework = COALESCE(accounting_framework, 'NIF')`
  );
}

function ensureInvoiceCurrencyColumns() {
  ensureColumnsOnTable('invoices', [
    { name: 'currency', type: 'TEXT' },
    { name: 'exchange_rate', type: 'REAL' },
    { name: 'subtotal_base', type: 'REAL' },
    { name: 'tax_amount_base', type: 'REAL' },
    { name: 'discount_amount_base', type: 'REAL' },
    { name: 'total_base', type: 'REAL' }
  ]);
}

function ensureAccountingTables() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        subtype TEXT,
        parent_id INTEGER,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        entry_date DATETIME NOT NULL,
        memo TEXT,
        source_type TEXT,
        source_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS journal_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        debit REAL DEFAULT 0,
        credit REAL DEFAULT 0,
        currency TEXT,
        exchange_rate REAL,
        amount_base REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run('CREATE INDEX IF NOT EXISTS idx_coa_company_code ON chart_of_accounts (company_id, code)');
    db.run('CREATE INDEX IF NOT EXISTS idx_journal_company_date ON journal_entries (company_id, entry_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines (entry_id)');
  });
}


function ensureAccountingOperationsTables() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS invoice_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        currency TEXT,
        exchange_rate REAL,
        amount_base REAL,
        method TEXT,
        notes TEXT,
        paid_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_name TEXT,
        subtotal REAL,
        tax_rate REAL,
        tax_amount REAL,
        total REAL,
        currency TEXT,
        exchange_rate REAL,
        subtotal_base REAL,
        tax_amount_base REAL,
        total_base REAL,
        status TEXT,
        company_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS bill_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bill_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        currency TEXT,
        exchange_rate REAL,
        amount_base REAL,
        method TEXT,
        notes TEXT,
        paid_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run('CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments (invoice_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_invoice_payments_company ON invoice_payments (company_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_bills_company ON bills (company_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments (bill_id)');
  });
}

function ensureNifAccountingTables() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'mayor',
        subtype TEXT,
        framework TEXT,
        category_id INTEGER,
        parent_id INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        depreciable INTEGER NOT NULL DEFAULT 0,
        is_depreciation INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        entry_date DATETIME NOT NULL,
        description TEXT,
        user_id INTEGER,
        memo TEXT,
        source_type TEXT,
        source_id INTEGER,
        currency TEXT,
        exchange_rate REAL,
        tax_rate REAL,
        tax_amount REAL,
        tax_type TEXT,
        status TEXT NOT NULL DEFAULT 'posted',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS journal_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        line_memo TEXT,
        debit REAL DEFAULT 0,
        credit REAL DEFAULT 0,
        currency TEXT,
        exchange_rate REAL,
        debit_base REAL DEFAULT 0,
        credit_base REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS financial_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        report_type TEXT NOT NULL,
        period_start TEXT,
        period_end TEXT,
        data_json TEXT,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS accounting_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        framework TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS accounting_category_assignments_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        company_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        previous_category_id INTEGER,
        new_category_id INTEGER,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS accounting_category_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        framework TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        target_category_code TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS bank_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        bank_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_sync DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS bank_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        txn_date DATETIME,
        description TEXT,
        amount REAL,
        currency TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run('CREATE INDEX IF NOT EXISTS idx_accounts_company_code ON accounts (company_id, code)');
    db.run('CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts (parent_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date ON journal_entries (company_id, entry_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_journal_details_entry ON journal_details (entry_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_journal_details_account ON journal_details (account_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_financial_reports_company ON financial_reports (company_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_accounting_categories_company ON accounting_categories (company_id, framework)');
    db.run('CREATE INDEX IF NOT EXISTS idx_category_assignments_batch ON accounting_category_assignments_history (batch_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_category_rules_company ON accounting_category_rules (company_id, framework)');
    db.run('CREATE INDEX IF NOT EXISTS idx_bank_connections_company ON bank_connections (company_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_bank_transactions_connection ON bank_transactions (connection_id)');
  });

  ensureColumnsOnTable('journal_entries', [
    { name: 'description', type: 'TEXT' },
    { name: 'user_id', type: 'INTEGER' },
    { name: 'currency', type: 'TEXT' },
    { name: 'exchange_rate', type: 'REAL' },
    { name: 'tax_rate', type: 'REAL' },
    { name: 'tax_amount', type: 'REAL' },
    { name: 'tax_type', type: 'TEXT' },
    { name: 'status', type: "TEXT NOT NULL DEFAULT 'posted'" }
  ]);

  ensureColumnsOnTable('journal_details', [
    { name: 'currency', type: 'TEXT' },
    { name: 'exchange_rate', type: 'REAL' },
    { name: 'debit_base', type: 'REAL' },
    { name: 'credit_base', type: 'REAL' }
  ]);

  ensureColumnsOnTable('accounts', [
    { name: 'framework', type: 'TEXT' },
    { name: 'category_id', type: 'INTEGER' }
  ]);
}

function backfillJournalBaseAmounts() {
  db.run('UPDATE journal_details SET debit_base = debit WHERE debit_base IS NULL');
  db.run('UPDATE journal_details SET credit_base = credit WHERE credit_base IS NULL');
  db.run('UPDATE journal_details SET currency = (SELECT base_currency FROM companies WHERE companies.id = journal_details.company_id) WHERE currency IS NULL');
  db.run('UPDATE journal_details SET exchange_rate = 1 WHERE exchange_rate IS NULL');
  db.run('UPDATE journal_entries SET currency = (SELECT base_currency FROM companies WHERE companies.id = journal_entries.company_id) WHERE currency IS NULL');
  db.run('UPDATE journal_entries SET exchange_rate = 1 WHERE exchange_rate IS NULL');
}

const NIF_TYPES = ['ACTIVO', 'PASIVO', 'CAPITAL', 'INGRESO', 'GASTO'];
const NIF_SUBTYPES = ['EFECTIVO', 'BANCOS', 'CXC', 'INVENTARIOS', 'PPE', 'DEPRECIACION', 'OTROS'];
const ACCOUNTING_FRAMEWORKS = ['NIF', 'NIIF'];

function normalizeNifType(raw) {
  if (!raw) return null;
  const normalized = String(raw).trim().toUpperCase();
  if (normalized === 'ASSET') return 'ACTIVO';
  if (normalized === 'LIABILITY') return 'PASIVO';
  if (normalized === 'EQUITY') return 'CAPITAL';
  if (normalized === 'INCOME') return 'INGRESO';
  if (normalized === 'EXPENSE') return 'GASTO';
  if (normalized === 'ACTIVO') return 'ACTIVO';
  if (normalized === 'PASIVO') return 'PASIVO';
  if (normalized === 'CAPITAL') return 'CAPITAL';
  if (normalized === 'INGRESO') return 'INGRESO';
  if (normalized === 'GASTO') return 'GASTO';
  return null;
}

function normalizeNifSubtype(raw) {
  if (!raw) return null;
  const normalized = String(raw).trim().toUpperCase();
  if (NIF_SUBTYPES.includes(normalized)) return normalized;
  return null;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function isDebitPositive(type) {
  return type === 'ACTIVO' || type === 'GASTO';
}

function normalizeFramework(raw) {
  const normalized = String(raw || '').trim().toUpperCase();
  if (ACCOUNTING_FRAMEWORKS.includes(normalized)) return normalized;
  return 'NIF';
}

function seedAccountingCategories(companyId, callback) {
  if (!Number.isInteger(companyId) || companyId <= 0) {
    if (callback) callback();
    return;
  }
  db.get(
    'SELECT id FROM accounting_categories WHERE company_id = ? LIMIT 1',
    [companyId],
    (err, row) => {
      if (err || row) {
        if (callback) callback();
        return;
      }

      const categories = [
        { framework: 'NIF', code: 'ACT-CIRC', name: 'Activo circulante', type: 'ACTIVO', sort: 10 },
        { framework: 'NIF', code: 'ACT-NC', name: 'Activo no circulante', type: 'ACTIVO', sort: 20 },
        { framework: 'NIF', code: 'PAS-CORTO', name: 'Pasivo corto plazo', type: 'PASIVO', sort: 30 },
        { framework: 'NIF', code: 'PAS-LARGO', name: 'Pasivo largo plazo', type: 'PASIVO', sort: 40 },
        { framework: 'NIF', code: 'CAPITAL', name: 'Capital contable', type: 'CAPITAL', sort: 50 },
        { framework: 'NIF', code: 'ING-ORD', name: 'Ingresos ordinarios', type: 'INGRESO', sort: 60 },
        { framework: 'NIF', code: 'ING-OTR', name: 'Otros ingresos', type: 'INGRESO', sort: 65 },
        { framework: 'NIF', code: 'GAS-OP', name: 'Gastos de operaciÃ³n', type: 'GASTO', sort: 70 },
        { framework: 'NIF', code: 'GAS-FIN', name: 'Gastos financieros', type: 'GASTO', sort: 75 },
        { framework: 'NIF', code: 'GAS-OTR', name: 'Otros gastos', type: 'GASTO', sort: 80 },
        { framework: 'NIIF', code: 'ACT-CURRENT', name: 'Activos corrientes', type: 'ACTIVO', sort: 10 },
        { framework: 'NIIF', code: 'ACT-NONCURRENT', name: 'Activos no corrientes', type: 'ACTIVO', sort: 20 },
        { framework: 'NIIF', code: 'ACT-INV', name: 'Propiedad de inversiÃ³n', type: 'ACTIVO', sort: 25 },
        { framework: 'NIIF', code: 'ACT-INT', name: 'Activos intangibles', type: 'ACTIVO', sort: 27 },
        { framework: 'NIIF', code: 'ACT-DEF', name: 'Activos por impuestos diferidos', type: 'ACTIVO', sort: 29 },
        { framework: 'NIIF', code: 'PAS-CURRENT', name: 'Pasivos corrientes', type: 'PASIVO', sort: 30 },
        { framework: 'NIIF', code: 'PAS-NONCURRENT', name: 'Pasivos no corrientes', type: 'PASIVO', sort: 40 },
        { framework: 'NIIF', code: 'PAS-DEF', name: 'Pasivos por impuestos diferidos', type: 'PASIVO', sort: 42 },
        { framework: 'NIIF', code: 'EQUITY', name: 'Patrimonio', type: 'CAPITAL', sort: 50 },
        { framework: 'NIIF', code: 'REVENUE', name: 'Ingresos', type: 'INGRESO', sort: 60 },
        { framework: 'NIIF', code: 'OTHER-INCOME', name: 'Otros ingresos', type: 'INGRESO', sort: 65 },
        { framework: 'NIIF', code: 'COSTS', name: 'Costos', type: 'GASTO', sort: 70 },
        { framework: 'NIIF', code: 'EXPENSES', name: 'Gastos', type: 'GASTO', sort: 75 },
        { framework: 'NIIF', code: 'FIN-EXP', name: 'Gastos financieros', type: 'GASTO', sort: 80 },
        { framework: 'NIIF', code: 'OTHER-EXP', name: 'Otros gastos', type: 'GASTO', sort: 85 }
      ];

      const stmt = db.prepare(
        `INSERT INTO accounting_categories (company_id, framework, code, name, type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      categories.forEach((cat) => {
        stmt.run(companyId, cat.framework, cat.code, cat.name, cat.type, cat.sort);
      });
      stmt.finalize(() => {
        if (callback) callback();
      });
    }
  );
}

function fetchAccountingCategories(companyId, framework, callback) {
  const resolved = normalizeFramework(framework);
  db.all(
    `SELECT id, code, name, type, sort_order
     FROM accounting_categories
     WHERE company_id = ? AND framework = ?
     ORDER BY sort_order, code`,
    [companyId, resolved],
    (err, rows) => {
      if (err) return callback([]);
      return callback(rows || []);
    }
  );
}

function inferCategoryCode(framework, account) {
  const name = String(account.name || '').toLowerCase();
  const type = account.type;
  const isNiif = framework === 'NIIF';

  if (type === 'ACTIVO') {
    if (name.includes('impuesto diferido')) return isNiif ? 'ACT-DEF' : 'ACT-NC';
    if (name.includes('intang')) return isNiif ? 'ACT-INT' : 'ACT-NC';
    if (name.includes('inversion')) return isNiif ? 'ACT-INV' : 'ACT-NC';
    if (name.includes('propiedad') || name.includes('planta') || name.includes('equipo')) {
      return isNiif ? 'ACT-NONCURRENT' : 'ACT-NC';
    }
    if (name.includes('no corriente') || name.includes('no circulante') || name.includes('largo plazo')) {
      return isNiif ? 'ACT-NONCURRENT' : 'ACT-NC';
    }
    return isNiif ? 'ACT-CURRENT' : 'ACT-CIRC';
  }

  if (type === 'PASIVO') {
    if (name.includes('impuesto diferido')) return isNiif ? 'PAS-DEF' : 'PAS-LARGO';
    if (name.includes('no corriente') || name.includes('largo plazo')) return isNiif ? 'PAS-NONCURRENT' : 'PAS-LARGO';
    return isNiif ? 'PAS-CURRENT' : 'PAS-CORTO';
  }

  if (type === 'CAPITAL') return isNiif ? 'EQUITY' : 'CAPITAL';

  if (type === 'INGRESO') {
    if (name.includes('otro')) return isNiif ? 'OTHER-INCOME' : 'ING-OTR';
    return isNiif ? 'REVENUE' : 'ING-ORD';
  }

  if (type === 'GASTO') {
    if (name.includes('financ')) return isNiif ? 'FIN-EXP' : 'GAS-FIN';
    if (name.includes('otro')) return isNiif ? 'OTHER-EXP' : 'GAS-OTR';
    if (name.includes('costo')) return isNiif ? 'COSTS' : 'GAS-OP';
    return isNiif ? 'EXPENSES' : 'GAS-OP';
  }

  return null;
}

function autoAssignAccountCategories({ companyId, framework }, callback) {
  const resolved = normalizeFramework(framework);
  fetchAccountingCategories(companyId, resolved, (categories) => {
    const codeToId = new Map(categories.map((cat) => [cat.code, cat.id]));
    db.all(
      `SELECT id, name, type, category_id
       FROM accounts
       WHERE company_id = ? AND (framework = ? OR framework IS NULL)`,
      [companyId, resolved],
      (err, rows) => {
        if (err) return callback({ updated: 0, skipped: 0 });
        let updated = 0;
        let skipped = 0;
        const stmt = db.prepare('UPDATE accounts SET category_id = ? WHERE id = ?');
        rows.forEach((acc) => {
          if (acc.category_id) {
            skipped += 1;
            return;
          }
          const code = inferCategoryCode(resolved, acc);
          const categoryId = code ? codeToId.get(code) : null;
          if (!categoryId) {
            skipped += 1;
            return;
          }
          stmt.run(categoryId, acc.id);
          updated += 1;
        });
        stmt.finalize(() => callback({ updated, skipped }));
      }
    );
  });
}

function buildAutoAssignPlan({ companyId, framework }, callback) {
  const resolved = normalizeFramework(framework);
  loadAutoAssignRules({ companyId, framework: resolved }, (rules) => {
    fetchAccountingCategories(companyId, resolved, (categories) => {
      const codeToId = new Map(categories.map((cat) => [cat.code, cat.id]));
      const idToCategory = new Map(categories.map((cat) => [cat.id, cat]));
      db.all(
        `SELECT id, code, name, type, category_id
         FROM accounts
         WHERE company_id = ? AND (framework = ? OR framework IS NULL)
         ORDER BY code`,
        [companyId, resolved],
        (err, rows) => {
          if (err) return callback({ framework: resolved, items: [] });
          const items = rows.map((acc) => {
            const inferredCode = inferCategoryCodeWithRules({ framework: resolved, account: acc, rules });
            const newCategoryId = inferredCode ? codeToId.get(inferredCode) : null;
            const newCategory = newCategoryId ? idToCategory.get(newCategoryId) : null;
            return {
              account: acc,
              inferredCode,
              newCategoryId,
              newCategory
            };
          });
          return callback({ framework: resolved, items });
        }
      );
    });
  });
}

function loadAutoAssignRules({ companyId, framework }, callback) {
  const resolved = normalizeFramework(framework);
  tableExists('accounting_category_rules', (exists) => {
    if (!exists) return callback([]);
    db.all(
      `SELECT id, rule_text, target_category_code, priority
       FROM accounting_category_rules
       WHERE company_id = ? AND framework = ? AND is_active = 1
       ORDER BY priority DESC, id ASC`,
      [companyId, resolved],
      (err, rows) => {
        if (err) return callback([]);
        return callback(rows || []);
      }
    );
  });
}

function inferCategoryCodeWithRules({ framework, account, rules }) {
  const name = String(account.name || '').toLowerCase();
  for (const rule of rules || []) {
    const needle = String(rule.rule_text || '').toLowerCase();
    if (!needle) continue;
    if (name.includes(needle)) {
      return rule.target_category_code;
    }
  }
  return inferCategoryCode(framework, account);
}

function autoAssignAccountCategoriesWithRules({ companyId, framework }, callback) {
  const resolved = normalizeFramework(framework);
  loadAutoAssignRules({ companyId, framework: resolved }, (rules) => {
    fetchAccountingCategories(companyId, resolved, (categories) => {
      const codeToId = new Map(categories.map((cat) => [cat.code, cat.id]));
      db.all(
        `SELECT id, name, type, category_id
         FROM accounts
         WHERE company_id = ? AND (framework = ? OR framework IS NULL)`,
        [companyId, resolved],
        (err, rows) => {
          if (err) return callback({ updated: 0, skipped: 0 });
          let updated = 0;
          let skipped = 0;
          const stmt = db.prepare('UPDATE accounts SET category_id = ? WHERE id = ?');
          rows.forEach((acc) => {
            if (acc.category_id) {
              skipped += 1;
              return;
            }
            const code = inferCategoryCodeWithRules({ framework: resolved, account: acc, rules });
            const categoryId = code ? codeToId.get(code) : null;
            if (!categoryId) {
              skipped += 1;
              return;
            }
            stmt.run(categoryId, acc.id);
            updated += 1;
          });
          stmt.finalize(() => callback({ updated, skipped }));
        }
      );
    });
  });
}

function seedNifCatalog(companyId, callback) {
  if (!Number.isInteger(companyId) || companyId <= 0) {
    if (callback) callback();
    return;
  }
  db.get('SELECT id FROM accounts WHERE company_id = ? LIMIT 1', [companyId], (err, row) => {
    if (err || row) {
      if (callback) callback();
      return;
    }

    db.get('SELECT accounting_framework FROM companies WHERE id = ?', [companyId], (fwErr, fwRow) => {
      const framework = normalizeFramework(fwRow ? fwRow.accounting_framework : 'NIF');

      const catalog = [
      { code: '1000', name: 'Activo', type: 'ACTIVO', level: 'mayor' },
      { code: '1100', name: 'Activo circulante', type: 'ACTIVO', level: 'mayor', parent: '1000' },
      { code: '1110', name: 'Efectivo y equivalentes', type: 'ACTIVO', level: 'subcuenta', parent: '1100', subtype: 'EFECTIVO' },
      { code: '1120', name: 'Cuentas por cobrar', type: 'ACTIVO', level: 'subcuenta', parent: '1100', subtype: 'CXC' },
      { code: '1130', name: 'Inventarios', type: 'ACTIVO', level: 'subcuenta', parent: '1100', subtype: 'INVENTARIOS' },
      { code: '1200', name: 'Activo no circulante', type: 'ACTIVO', level: 'mayor', parent: '1000' },
      { code: '1210', name: 'Propiedad, planta y equipo', type: 'ACTIVO', level: 'subcuenta', parent: '1200', subtype: 'PPE', depreciable: 1 },
      { code: '1211', name: 'DepreciaciÃ³n acumulada', type: 'ACTIVO', level: 'subcuenta', parent: '1200', subtype: 'DEPRECIACION', is_depreciation: 1 },
      { code: '2000', name: 'Pasivo', type: 'PASIVO', level: 'mayor' },
      { code: '2100', name: 'Pasivo a corto plazo', type: 'PASIVO', level: 'mayor', parent: '2000' },
      { code: '2110', name: 'Proveedores', type: 'PASIVO', level: 'subcuenta', parent: '2100' },
      { code: '2120', name: 'Impuestos por pagar', type: 'PASIVO', level: 'subcuenta', parent: '2100' },
      { code: '2200', name: 'Pasivo a largo plazo', type: 'PASIVO', level: 'mayor', parent: '2000' },
      { code: '2210', name: 'PrÃ©stamos bancarios', type: 'PASIVO', level: 'subcuenta', parent: '2200' },
      { code: '3000', name: 'Capital', type: 'CAPITAL', level: 'mayor' },
      { code: '3100', name: 'Capital social', type: 'CAPITAL', level: 'subcuenta', parent: '3000' },
      { code: '3200', name: 'Utilidades retenidas', type: 'CAPITAL', level: 'subcuenta', parent: '3000' },
      { code: '4000', name: 'Ingresos', type: 'INGRESO', level: 'mayor' },
      { code: '4100', name: 'Ventas', type: 'INGRESO', level: 'subcuenta', parent: '4000' },
      { code: '4200', name: 'Otros ingresos', type: 'INGRESO', level: 'subcuenta', parent: '4000' },
      { code: '5000', name: 'Gastos', type: 'GASTO', level: 'mayor' },
      { code: '5100', name: 'Costo de ventas', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5200', name: 'Gastos de venta', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5300', name: 'Gastos administrativos', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5400', name: 'Gastos financieros', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5500', name: 'DepreciaciÃ³n', type: 'GASTO', level: 'subcuenta', parent: '5000', subtype: 'DEPRECIACION' }
      ];

      const idByCode = new Map();
      const insertAccount = (acc, parentId, done) => {
        db.run(
          `INSERT INTO accounts (company_id, code, name, type, level, subtype, parent_id, depreciable, is_depreciation, framework)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            companyId,
            acc.code,
            acc.name,
            acc.type,
            acc.level,
            acc.subtype || null,
            parentId || null,
            acc.depreciable ? 1 : 0,
            acc.is_depreciation ? 1 : 0,
            framework
          ],
          function (err) {
            if (!err) {
              idByCode.set(acc.code, this.lastID);
            }
            done();
          }
        );
      };

      const majors = catalog.filter((acc) => !acc.parent);
      const subs = catalog.filter((acc) => acc.parent);
      let remaining = majors.length + subs.length;
      const done = () => {
        remaining -= 1;
        if (remaining <= 0 && callback) callback();
      };

      majors.forEach((acc) => {
        insertAccount(acc, null, done);
      });

      const pending = [...subs];
      const drainPending = () => {
        let progress = false;
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          const acc = pending[i];
          const parentId = idByCode.get(acc.parent);
          if (parentId) {
            pending.splice(i, 1);
            insertAccount(acc, parentId, done);
            progress = true;
          }
        }
        if (!pending.length) return;
        if (!progress) {
          pending.forEach((acc) => insertAccount(acc, null, done));
          pending.length = 0;
          return;
        }
        setImmediate(drainPending);
      };

      drainPending();
    });
  });
}

function seedNifCatalogForAllCompanies() {
  db.all('SELECT id FROM companies', (err, rows) => {
    if (err || !rows) return;
    rows.forEach((row) => {
      seedAccountingCategories(row.id);
      seedNifCatalog(row.id);
    });
  });
}

function seedNiifCatalog(companyId, callback) {
  if (!Number.isInteger(companyId) || companyId <= 0) {
    if (callback) callback();
    return;
  }
  db.get('SELECT id FROM accounts WHERE company_id = ? LIMIT 1', [companyId], (err, row) => {
    if (err || row) {
      if (callback) callback();
      return;
    }

    const catalog = [
      { code: '1000', name: 'Activos', type: 'ACTIVO', level: 'mayor' },
      { code: '1100', name: 'Activos corrientes', type: 'ACTIVO', level: 'mayor', parent: '1000' },
      { code: '1110', name: 'Efectivo y equivalentes', type: 'ACTIVO', level: 'subcuenta', parent: '1100', subtype: 'EFECTIVO' },
      { code: '1120', name: 'Cuentas por cobrar', type: 'ACTIVO', level: 'subcuenta', parent: '1100', subtype: 'CXC' },
      { code: '1130', name: 'Inventarios', type: 'ACTIVO', level: 'subcuenta', parent: '1100', subtype: 'INVENTARIOS' },
      { code: '1200', name: 'Activos no corrientes', type: 'ACTIVO', level: 'mayor', parent: '1000' },
      { code: '1210', name: 'Propiedad, planta y equipo', type: 'ACTIVO', level: 'subcuenta', parent: '1200', subtype: 'PPE', depreciable: 1 },
      { code: '1220', name: 'Activos intangibles', type: 'ACTIVO', level: 'subcuenta', parent: '1200' },
      { code: '1230', name: 'Propiedad de inversiÃ³n', type: 'ACTIVO', level: 'subcuenta', parent: '1200' },
      { code: '1240', name: 'Activos por impuestos diferidos', type: 'ACTIVO', level: 'subcuenta', parent: '1200' },
      { code: '1250', name: 'DepreciaciÃ³n acumulada', type: 'ACTIVO', level: 'subcuenta', parent: '1200', subtype: 'DEPRECIACION', is_depreciation: 1 },
      { code: '2000', name: 'Pasivos', type: 'PASIVO', level: 'mayor' },
      { code: '2100', name: 'Pasivos corrientes', type: 'PASIVO', level: 'mayor', parent: '2000' },
      { code: '2110', name: 'Proveedores', type: 'PASIVO', level: 'subcuenta', parent: '2100' },
      { code: '2120', name: 'Impuestos por pagar', type: 'PASIVO', level: 'subcuenta', parent: '2100' },
      { code: '2200', name: 'Pasivos no corrientes', type: 'PASIVO', level: 'mayor', parent: '2000' },
      { code: '2210', name: 'PrÃ©stamos bancarios', type: 'PASIVO', level: 'subcuenta', parent: '2200' },
      { code: '2220', name: 'Pasivos por impuestos diferidos', type: 'PASIVO', level: 'subcuenta', parent: '2200' },
      { code: '3000', name: 'Patrimonio', type: 'CAPITAL', level: 'mayor' },
      { code: '3100', name: 'Capital social', type: 'CAPITAL', level: 'subcuenta', parent: '3000' },
      { code: '3200', name: 'Resultados acumulados', type: 'CAPITAL', level: 'subcuenta', parent: '3000' },
      { code: '4000', name: 'Ingresos', type: 'INGRESO', level: 'mayor' },
      { code: '4100', name: 'Ventas', type: 'INGRESO', level: 'subcuenta', parent: '4000' },
      { code: '4200', name: 'Otros ingresos', type: 'INGRESO', level: 'subcuenta', parent: '4000' },
      { code: '5000', name: 'Gastos', type: 'GASTO', level: 'mayor' },
      { code: '5100', name: 'Costos', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5200', name: 'Gastos de administraciÃ³n', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5300', name: 'Gastos de venta', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5400', name: 'Gastos financieros', type: 'GASTO', level: 'subcuenta', parent: '5000' },
      { code: '5500', name: 'DepreciaciÃ³n', type: 'GASTO', level: 'subcuenta', parent: '5000', subtype: 'DEPRECIACION' }
    ];

    const idByCode = new Map();
    const insertAccount = (acc, parentId, done) => {
      db.run(
        `INSERT INTO accounts (company_id, code, name, type, level, subtype, parent_id, depreciable, is_depreciation, framework)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          acc.code,
          acc.name,
          acc.type,
          acc.level,
          acc.subtype || null,
          parentId || null,
          acc.depreciable ? 1 : 0,
          acc.is_depreciation ? 1 : 0,
          'NIIF'
        ],
        function (err) {
          if (!err) {
            idByCode.set(acc.code, this.lastID);
          }
          done();
        }
      );
    };

    const majors = catalog.filter((acc) => !acc.parent);
    const subs = catalog.filter((acc) => acc.parent);
    let remaining = majors.length + subs.length;
    const done = () => {
      remaining -= 1;
      if (remaining <= 0 && callback) callback();
    };

    majors.forEach((acc) => {
      insertAccount(acc, null, done);
    });

    const pending = [...subs];
    const drainPending = () => {
      let progress = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const acc = pending[i];
        const parentId = idByCode.get(acc.parent);
        if (parentId) {
          pending.splice(i, 1);
          insertAccount(acc, parentId, done);
          progress = true;
        }
      }
      if (!pending.length) return;
      if (!progress) {
        pending.forEach((acc) => insertAccount(acc, null, done));
        pending.length = 0;
        return;
      }
      setImmediate(drainPending);
    };

    drainPending();
  });
}

function parseJournalLines(body) {
  const accountIds = normalizeArray(body.account_id);
  const debits = normalizeArray(body.debit);
  const credits = normalizeArray(body.credit);
  const memos = normalizeArray(body.line_memo);
  const lines = [];
  for (let i = 0; i < accountIds.length; i += 1) {
    const accountId = Number(accountIds[i]);
    const debit = Number(debits[i] || 0);
    const credit = Number(credits[i] || 0);
    const memo = memos[i] ? String(memos[i]).trim() : null;
    if (!Number.isInteger(accountId) || accountId <= 0) continue;
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) continue;
    if (debit <= 0 && credit <= 0) continue;
    lines.push({
      account_id: accountId,
      debit: debit > 0 ? debit : 0,
      credit: credit > 0 ? credit : 0,
      line_memo: memo
    });
  }
  return lines;
}

function validateJournalLines(lines) {
  const totals = { debit: 0, credit: 0 };
  lines.forEach((line) => {
    totals.debit += Number(line.debit || 0);
    totals.credit += Number(line.credit || 0);
  });
  const diff = Math.abs(totals.debit - totals.credit);
  return {
    totals,
    isBalanced: totals.debit > 0 && diff < 0.005
  };
}

function seedDefaultChartOfAccounts(companyId, callback) {
  const defaults = [
    { code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
    { code: '1100', name: 'Accounts Receivable', type: 'asset', subtype: 'receivable' },
    { code: '1200', name: 'Inventory', type: 'asset', subtype: 'inventory' },
    { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'payable' },
    { code: '2100', name: 'Taxes Payable', type: 'liability', subtype: 'tax' },
    { code: '3000', name: 'Owner Equity', type: 'equity', subtype: 'equity' },
    { code: '4000', name: 'Sales Revenue', type: 'income', subtype: 'revenue' },
    { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cogs' }
  ];

  db.get('SELECT id FROM chart_of_accounts WHERE company_id = ? LIMIT 1', [companyId], (err, row) => {
    if (err || row) {
      if (callback) callback();
      return;
    }
    const stmt = db.prepare(
      'INSERT INTO chart_of_accounts (company_id, code, name, type, subtype) VALUES (?, ?, ?, ?, ?)'
    );
    defaults.forEach((acc) => {
      stmt.run(companyId, acc.code, acc.name, acc.type, acc.subtype);
    });
    stmt.finalize(() => {
      if (callback) callback();
    });
  });
}

function seedChartOfAccountsForAllCompanies() {
  db.all('SELECT id FROM companies', (err, rows) => {
    if (err || !rows) return;
    rows.forEach((row) => seedDefaultChartOfAccounts(row.id));
  });
}

function getAccountIdByCode(companyId, code, callback) {
  db.get(
    'SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ? LIMIT 1',
    [companyId, code],
    (err, row) => {
      if (err || !row) return callback(null);
      return callback(row.id);
    }
  );
}


function getCompanySettings(companyId, callback) {
  db.get(
    'SELECT * FROM companies WHERE id = ?',
    [companyId],
    (err, company) => {
      if (err || !company) return callback(null);
      const baseCurrency = String((company.base_currency || company.currency || 'GTQ')).toUpperCase();
      const allowedCurrencies = parseCurrencyList(company.allowed_currencies, baseCurrency);
      return callback({
        ...company,
        base_currency: baseCurrency,
        allowed_currencies: allowedCurrencies,
        accounting_framework: company.accounting_framework || 'NIF'
      });
    }
  );
}

function fetchAccountingReports(companyId, callback) {
  db.all(
    `SELECT coa.id, coa.code, coa.name, coa.type, coa.subtype,
            COALESCE(SUM(jl.debit), 0) AS debit,
            COALESCE(SUM(jl.credit), 0) AS credit
     FROM chart_of_accounts coa
     LEFT JOIN journal_lines jl ON jl.account_id = coa.id AND jl.company_id = ?
     WHERE coa.company_id = ?
     GROUP BY coa.id
     ORDER BY coa.code`,
    [companyId, companyId],
    (err, rows) => {
      if (err) return callback({ ledger: [], totals: {} });
      const ledger = (rows || []).map((row) => {
        const debit = Number(row.debit || 0);
        const credit = Number(row.credit || 0);
        let balance = 0;
        if (row.type === 'asset' || row.type === 'expense') {
          balance = debit - credit;
        } else {
          balance = credit - debit;
        }
        return { ...row, debit, credit, balance };
      });

      const totals = {
        assets: 0,
        liabilities: 0,
        equity: 0,
        income: 0,
        expenses: 0
      };

      ledger.forEach((row) => {
        if (row.type === 'asset') totals.assets += row.balance;
        if (row.type === 'liability') totals.liabilities += row.balance;
        if (row.type === 'equity') totals.equity += row.balance;
        if (row.type === 'income') totals.income += row.balance;
        if (row.type === 'expense') totals.expenses += row.balance;
      });

      totals.net_income = totals.income - totals.expenses;
      totals.balance_total = totals.assets - (totals.liabilities + totals.equity + totals.net_income);

      return callback({ ledger, totals });
    }
  );
}

function fetchNifAccounts(companyId, framework, callback) {
  const resolved = normalizeFramework(framework);
  db.all(
    `SELECT a.id, a.code, a.name, a.type, a.level, a.subtype, a.parent_id, a.is_active, a.depreciable, a.is_depreciation,
            a.framework, a.category_id, c.name AS category_name
     FROM accounts a
     LEFT JOIN accounting_categories c ON c.id = a.category_id
     WHERE a.company_id = ? AND (a.framework = ? OR a.framework IS NULL)
     ORDER BY a.code`,
    [companyId, resolved],
    (err, rows) => {
      if (err) return callback([]);
      return callback(rows || []);
    }
  );
}

function fetchNifTrialBalance(companyId, filters, callback) {
  const params = [];
  const framework = normalizeFramework(filters && filters.framework);
  let selectDebit = 'COALESCE(SUM(jd.debit), 0) AS debit';
  let selectCredit = 'COALESCE(SUM(jd.credit), 0) AS credit';
  if (filters && (filters.startDate || filters.endDate)) {
    const conditions = [];
    const dateParams = [];
    if (filters.startDate) {
      conditions.push('je.entry_date >= ?');
      dateParams.push(filters.startDate);
    }
    if (filters.endDate) {
      conditions.push('je.entry_date <= ?');
      dateParams.push(filters.endDate);
    }
    const condition = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    selectDebit = `COALESCE(SUM(CASE WHEN je.id IS NOT NULL ${condition} THEN jd.debit_base ELSE 0 END), 0) AS debit`;
    selectCredit = `COALESCE(SUM(CASE WHEN je.id IS NOT NULL ${condition} THEN jd.credit_base ELSE 0 END), 0) AS credit`;
    params.push(...dateParams, ...dateParams);
  }
  if (!(filters && (filters.startDate || filters.endDate))) {
    selectDebit = 'COALESCE(SUM(jd.debit_base), 0) AS debit';
    selectCredit = 'COALESCE(SUM(jd.credit_base), 0) AS credit';
  }
  params.push(companyId, companyId, companyId, framework);

  db.all(
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.category_id,
            ${selectDebit},
            ${selectCredit}
     FROM accounts a
     LEFT JOIN journal_details jd ON jd.account_id = a.id AND jd.company_id = ?
     LEFT JOIN journal_entries je ON je.id = jd.entry_id AND je.company_id = ?
     WHERE a.company_id = ? AND (a.framework = ? OR a.framework IS NULL)
     GROUP BY a.id
     ORDER BY a.code`,
    params,
    (err, rows) => {
      if (err) return callback([]);
      const mapped = (rows || []).map((row) => {
        const debit = Number(row.debit || 0);
        const credit = Number(row.credit || 0);
        const balance = isDebitPositive(row.type) ? debit - credit : credit - debit;
        return { ...row, debit, credit, balance };
      });
      return callback(mapped);
    }
  );
}

function fetchNifDiary(companyId, filters, callback) {
  const params = [companyId];
  const conditions = ['je.company_id = ?'];
  if (filters && filters.startDate) {
    conditions.push('je.entry_date >= ?');
    params.push(filters.startDate);
  }
  if (filters && filters.endDate) {
    conditions.push('je.entry_date <= ?');
    params.push(filters.endDate);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  db.all(
    `SELECT je.id AS entry_id, je.entry_date, je.description, je.memo, je.status,
            u.username AS user_name,
            jd.id AS line_id, jd.debit, jd.credit, jd.line_memo,
            a.code AS account_code, a.name AS account_name
     FROM journal_entries je
     LEFT JOIN users u ON u.id = je.user_id
     LEFT JOIN journal_details jd ON jd.entry_id = je.id AND jd.company_id = je.company_id
     LEFT JOIN accounts a ON a.id = jd.account_id AND a.company_id = je.company_id
     ${whereClause}
     ORDER BY je.entry_date ASC, je.id ASC, jd.id ASC`,
    params,
    (err, rows) => {
      if (err) return callback([]);
      return callback(rows || []);
    }
  );
}

function fetchNifLedger(companyId, filters, callback) {
  const params = [companyId];
  const conditions = ['je.company_id = ?'];
  if (filters && filters.startDate) {
    conditions.push('je.entry_date >= ?');
    params.push(filters.startDate);
  }
  if (filters && filters.endDate) {
    conditions.push('je.entry_date <= ?');
    params.push(filters.endDate);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  db.all(
    `SELECT a.id AS account_id, a.code, a.name, a.type,
            je.entry_date, je.description,
            jd.debit, jd.credit, jd.line_memo
     FROM accounts a
     LEFT JOIN journal_details jd ON jd.account_id = a.id AND jd.company_id = a.company_id
     LEFT JOIN journal_entries je ON je.id = jd.entry_id AND je.company_id = a.company_id
     ${whereClause}
     ORDER BY a.code, je.entry_date, jd.id`,
    params,
    (err, rows) => {
      if (err) return callback([]);
      return callback(rows || []);
    }
  );
}

function computeNifFinancials(balances) {
  const totals = {
    activos: 0,
    pasivos: 0,
    capital: 0,
    ingresos: 0,
    gastos: 0
  };

  (balances || []).forEach((row) => {
    if (row.type === 'ACTIVO') totals.activos += row.balance;
    if (row.type === 'PASIVO') totals.pasivos += row.balance;
    if (row.type === 'CAPITAL') totals.capital += row.balance;
    if (row.type === 'INGRESO') totals.ingresos += row.balance;
    if (row.type === 'GASTO') totals.gastos += row.balance;
  });

  totals.utilidad_neta = totals.ingresos - totals.gastos;
  totals.balance_cuadre = totals.activos - (totals.pasivos + totals.capital + totals.utilidad_neta);

  const cashAccounts = (balances || []).filter((row) =>
    row.type === 'ACTIVO' && (row.subtype === 'EFECTIVO' || row.subtype === 'BANCOS')
  );
  const flujo_efectivo = cashAccounts.reduce((sum, row) => sum + row.balance, 0);

  return { totals, flujo_efectivo };
}

function computeCategoryTotals({ balances, categories }) {
  const byId = new Map();
  (categories || []).forEach((cat) => {
    byId.set(cat.id, {
      id: cat.id,
      code: cat.code,
      name: cat.name,
      type: cat.type,
      total: 0
    });
  });
  const uncategorized = {
    id: null,
    code: 'NC',
    name: 'Sin categorÃ­a',
    type: 'VARIOS',
    total: 0
  };

  (balances || []).forEach((row) => {
    if (row.category_id && byId.has(row.category_id)) {
      byId.get(row.category_id).total += row.balance;
    } else {
      uncategorized.total += row.balance;
    }
  });

  const result = Array.from(byId.values()).filter((row) => Math.abs(row.total) > 0.0001);
  if (Math.abs(uncategorized.total) > 0.0001) {
    result.push(uncategorized);
  }
  return result;
}

function sendExcel(res, filename, sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(workbook, sheet.data, sheet.name);
  });
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.end(buffer);
}

function renderSimplePdf(res, title, rows) {
  const doc = new PDFDocument({ margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);
  doc.fontSize(16).text(title);
  doc.moveDown();
  doc.fontSize(10);
  rows.forEach((row) => {
    doc.text(row.join(' | '));
  });
  doc.end();
}

function createJournalEntry({ companyId, entryDate, memo, sourceType, sourceId, lines }, callback) {
  db.run(
    'INSERT INTO journal_entries (company_id, entry_date, memo, source_type, source_id) VALUES (?, ?, ?, ?, ?)',
    [companyId, entryDate, memo || null, sourceType || null, sourceId || null],
    function (err) {
      if (err) return callback(err);
      const entryId = this.lastID;
      const stmt = db.prepare(
        'INSERT INTO journal_lines (entry_id, company_id, account_id, debit, credit, currency, exchange_rate, amount_base) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      (lines || []).forEach((line) => {
        stmt.run(
          entryId,
          companyId,
          line.account_id,
          line.debit || 0,
          line.credit || 0,
          line.currency || null,
          line.exchange_rate || null,
          line.amount_base || 0
        );
      });
      stmt.finalize((finalErr) => callback(finalErr));
    }
  );
}function setFlash(req, type, message) {
  if (!req || !req.session) return;
  req.session.flash = { type, message };
}

function findCustomerTable(callback) {
  tableExists('customers', (exists) => {
    if (exists) return callback('customers');
    db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      (err, rows) => {
        if (err || !rows || rows.length === 0) return callback(null);
        const tables = rows.map((row) => row.name).filter((name) => name !== 'customers');
        const candidates = [];

        const checkNext = (index) => {
          if (index >= tables.length) {
            if (!candidates.length) return callback(null);
            candidates.sort((a, b) => b.score - a.score);
            return callback(candidates[0].table);
          }
          const table = tables[index];
          db.all(`PRAGMA table_info(${table})`, (infoErr, columns) => {
            if (!infoErr && columns && columns.length) {
              const names = columns.map((col) => col.name);
              const hasName = names.includes('name');
              const hasEmail = names.includes('email');
              const hasPhone = names.includes('phone');
              const hasAddress = names.includes('address');
              const hasCompany = names.includes('company_id');
              const tableName = String(table).toLowerCase();
              const nameMatch =
                tableName.includes('customer') || tableName.includes('cliente') || tableName.includes('client');
              let score = 0;
              if (nameMatch) score += 3;
              if (hasName) score += 2;
              if (hasEmail) score += 1;
              if (hasPhone) score += 1;
              if (hasAddress) score += 1;
              if (hasCompany) score += 1;
              if (hasName && (hasEmail || hasPhone)) {
                candidates.push({ table, score });
              }
            }
            return checkNext(index + 1);
          });
        };

        return checkNext(0);
      }
    );
  });
}

function findPackagesTable(callback) {
  tableExists('packages', (exists) => {
    if (exists) return callback('packages');
    db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      (err, rows) => {
        if (err || !rows || rows.length === 0) return callback(null);
        const tables = rows
          .map((row) => row.name)
          .filter((name) => !['package_photos', 'package_status_history', 'package_comments'].includes(name));
        const candidates = [];

        const checkNext = (index) => {
          if (index >= tables.length) {
            if (!candidates.length) return callback(null);
            candidates.sort((a, b) => b.score - a.score);
            return callback(candidates[0].table);
          }
          const table = tables[index];
          db.all(`PRAGMA table_info(${table})`, (infoErr, columns) => {
            if (!infoErr && columns && columns.length) {
              const names = columns.map((col) => col.name);
              const tableName = String(table).toLowerCase();
              const nameMatch =
                tableName.includes('package') ||
                tableName.includes('paquete') ||
                tableName.includes('shipment') ||
                tableName.includes('courier');
              const hasCustomer = names.includes('customer_id');
              const hasStatus = names.includes('status');
              const hasTracking = names.includes('tracking_number');
              const hasCarrier = names.includes('carrier');
              const hasWeight = names.includes('weight_lbs');
              const hasReceived = names.includes('received_at');
              const hasInternal = names.includes('internal_code');
              const hasDeclared = names.includes('declared_value');
              const hasCompany = names.includes('company_id');
              const hasCreated = names.includes('created_at');
              let score = 0;
              if (nameMatch) score += 3;
              if (hasCustomer) score += 2;
              if (hasStatus) score += 2;
              if (hasTracking) score += 2;
              if (hasCarrier) score += 1;
              if (hasWeight) score += 1;
              if (hasReceived) score += 1;
              if (hasInternal) score += 1;
              if (hasDeclared) score += 1;
              if (hasCompany) score += 1;
              if (hasCreated) score += 1;
              if (score >= 5) {
                candidates.push({ table, score });
              }
            }
            return checkNext(index + 1);
          });
        };

        return checkNext(0);
      }
    );
  });
}

function ensureCustomerPortalColumns() {
  findCustomerTable((table) => {
    if (!table) return;
    ensureColumn(table, 'portal_code', 'TEXT');
    ensureColumn(table, 'portal_password_hash', 'TEXT');
    ensureColumn(table, 'portal_password_reset_required', 'INTEGER DEFAULT 0');
  });
}

function ensureUsersPerCompanyUnique() {
  ensureUniqueIndexSafely(
    'users',
    ['company_id', 'username'],
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_company_username ON users (company_id, username)',
    {
      scope: 'users_company_username_unique',
      conflictColumnSets: [['username']],
      fallbackSql: 'CREATE INDEX IF NOT EXISTS idx_users_company_username_lookup ON users (company_id, username)'
    }
  );
}

function dedupeUsers(callback) {
  findDuplicateGroups('users', ['company_id', 'username'], { limit: 10 }, (err, duplicates) => {
    if (err) {
      logMigrationEvent('warn', 'users_dedupe', 'No se pudo validar usuarios duplicados antes de la migracion segura.', {
        error: err.message || String(err)
      });
    } else if (duplicates.length > 0) {
      logMigrationEvent('warn', 'users_dedupe', 'Se detectaron usuarios duplicados. La migracion segura no eliminara registros existentes.', {
        duplicates
      });
    }
    if (callback) callback();
  });
}

function rebuildUsersTable() {
  logMigrationEvent('warn', 'users_table', 'Se bloqueo una reconstruccion destructiva de la tabla users. La actualizacion segura no elimina ni recrea tablas en produccion.');
}

function ensureCategoriesPerCompanyUnique() {
  ensureUniqueIndexSafely(
    'categories',
    ['company_id', 'name'],
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_company_name ON categories (company_id, name)',
    {
      scope: 'categories_company_name_unique',
      conflictColumnSets: [['name']],
      fallbackSql: 'CREATE INDEX IF NOT EXISTS idx_categories_company_name_lookup ON categories (company_id, name)'
    }
  );
}

function rebuildCategoriesTable() {
  logMigrationEvent('warn', 'categories_table', 'Se bloqueo una reconstruccion destructiva de la tabla categories. La actualizacion segura no elimina ni recrea tablas en produccion.');
}

function countLegacyUserReferences(userId, callback) {
  db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name",
    (err, tables) => {
      if (err || !tables || tables.length === 0) {
        return callback(err || null, []);
      }
      let pending = tables.length;
      const references = [];
      const done = () => {
        pending -= 1;
        if (pending === 0) {
          callback(null, references);
        }
      };

      tables.forEach(({ name }) => {
        db.all(`PRAGMA table_info(${name})`, (infoErr, columns) => {
          if (infoErr || !columns || columns.length === 0) {
            return done();
          }
          const candidateColumns = columns
            .map((column) => column.name)
            .filter((column) => ['user_id', 'created_by', 'changed_by'].includes(column));
          if (candidateColumns.length === 0) {
            return done();
          }
          const where = candidateColumns.map((column) => `${column} = ?`).join(' OR ');
          const params = candidateColumns.map(() => userId);
          db.get(`SELECT COUNT(*) AS total FROM ${name} WHERE ${where}`, params, (countErr, row) => {
            if (!countErr && row && Number(row.total) > 0) {
              references.push({ table: name, total: Number(row.total) });
            }
            done();
          });
        });
      });
    }
  );
}

function resolveLegacyUsersOutsideActiveCompanies(companies, callback) {
  db.all(
    `SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.created_at, u.company_id
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.company_id IS NULL OR c.id IS NULL
     ORDER BY u.id ASC`,
    (userErr, users) => {
      if (userErr) return callback(userErr);
      if (!users || users.length === 0) {
        return callback(null, { assigned: [], orphaned: [], unresolved: [] });
      }
      db.all(
        `SELECT u.company_id, u.username
         FROM users u
         JOIN companies c ON c.id = u.company_id`,
        (scopedErr, scopedUsers) => {
          if (scopedErr) return callback(scopedErr);
          const usernamesByCompany = new Map();
          (scopedUsers || []).forEach((row) => {
            if (!row || row.company_id == null) return;
            const normalized = String(row.username || '').trim().toLowerCase();
            if (!normalized) return;
            if (!usernamesByCompany.has(row.company_id)) {
              usernamesByCompany.set(row.company_id, new Set());
            }
            usernamesByCompany.get(row.company_id).add(normalized);
          });

          const normalizedCompanies = (companies || []).map((company) => ({
            ...company,
            normalizedUsername: String(company.username || '').trim().toLowerCase()
          }));
          const assigned = [];
          const orphaned = [];
          const unresolved = [];

          const processNext = (index) => {
            if (index >= users.length) {
              return callback(null, { assigned, orphaned, unresolved });
            }
            const user = users[index];
            const normalizedUsername = String(user.username || '').trim().toLowerCase();
            const existingMatch = (companyId) => {
              const usernames = usernamesByCompany.get(companyId);
              return usernames ? usernames.has(normalizedUsername) : false;
            };

            const candidateMatches = [];
            const usernameMatches = normalizedCompanies.filter((company) => company.normalizedUsername === normalizedUsername);
            if (usernameMatches.length === 1) {
              candidateMatches.push({
                companyId: usernameMatches[0].id,
                reason: 'company_username'
              });
            }
            if (user.role === 'admin' && user.password_hash) {
              const passwordMatches = normalizedCompanies.filter(
                (company) => company.password_hash && company.password_hash === user.password_hash
              );
              if (passwordMatches.length === 1) {
                candidateMatches.push({
                  companyId: passwordMatches[0].id,
                  reason: 'company_password_hash'
                });
              }
              const companiesMissingAdmin = normalizedCompanies.filter((company) => !existingMatch(company.id));
              if (normalizedUsername === 'admin' && companiesMissingAdmin.length === 1) {
                candidateMatches.push({
                  companyId: companiesMissingAdmin[0].id,
                  reason: 'missing_company_admin'
                });
              }
            }

            const uniqueCandidates = [...new Set(candidateMatches.map((match) => match.companyId))];
            if (uniqueCandidates.length === 1 && !existingMatch(uniqueCandidates[0])) {
              const companyId = uniqueCandidates[0];
              const reason = candidateMatches.find((match) => match.companyId === companyId).reason;
              return db.run(
                'UPDATE users SET company_id = ?, is_active = 1 WHERE id = ?',
                [companyId, user.id],
                function (updateErr) {
                  if (updateErr || this.changes === 0) {
                    unresolved.push({
                      id: user.id,
                      username: user.username,
                      reason: updateErr ? updateErr.message || String(updateErr) : 'no_changes'
                    });
                  } else {
                    if (!usernamesByCompany.has(companyId)) {
                      usernamesByCompany.set(companyId, new Set());
                    }
                    usernamesByCompany.get(companyId).add(normalizedUsername);
                    assigned.push({
                      id: user.id,
                      username: user.username,
                      companyId,
                      reason
                    });
                  }
                  processNext(index + 1);
                }
              );
            }

            return countLegacyUserReferences(user.id, (referenceErr, references) => {
              if (!referenceErr && (!references || references.length === 0)) {
                return db.run(
                  'UPDATE users SET company_id = NULL, is_active = 0 WHERE id = ?',
                  [user.id],
                  (deactivateErr) => {
                    if (deactivateErr) {
                      unresolved.push({
                        id: user.id,
                        username: user.username,
                        reason: deactivateErr.message || String(deactivateErr)
                      });
                    } else {
                      orphaned.push({
                        id: user.id,
                        username: user.username
                      });
                    }
                    processNext(index + 1);
                  }
                );
              }
              unresolved.push({
                id: user.id,
                username: user.username,
                references: references || [],
                reason: referenceErr ? referenceErr.message || String(referenceErr) : 'ambiguous'
              });
              processNext(index + 1);
            });
          };

          processNext(0);
        }
      );
    }
  );
}

function backfillCompanyIdForExisting() {
  db.all('SELECT id, username, password_hash FROM companies ORDER BY id ASC', (err, rows) => {
    if (err || !rows || rows.length === 0) return;
    const companyId = rows.length === 1 ? rows[0].id : null;
    const tables = ['users', 'items', 'categories', 'brands', 'customers', 'invoices', 'invoice_items', 'audit_logs', 'awbs'];
    if (!companyId) {
      resolveLegacyUsersOutsideActiveCompanies(rows, (resolveErr, userResolution) => {
        if (resolveErr) {
          logMigrationEvent('warn', 'company_id_backfill', 'No se pudo evaluar users fuera de una empresa valida durante la migracion segura.', {
            error: resolveErr.message || String(resolveErr)
          });
        } else {
          if (userResolution.assigned.length > 0) {
            logMigrationEvent('info', 'company_id_backfill', 'Se reasignaron usuarios heredados a una empresa usando reglas seguras.', {
              users: userResolution.assigned
            });
          }
          if (userResolution.orphaned.length > 0) {
            logMigrationEvent('warn', 'company_id_backfill', 'Se desactivaron usuarios heredados fuera de una empresa valida y sin referencias activas.', {
              users: userResolution.orphaned
            });
          }
        }

        const userUnresolvedTotal =
          userResolution && Array.isArray(userResolution.unresolved) ? userResolution.unresolved.length : null;
        const tableChecks = tables.filter((table) => table !== 'users');
        let pending = tableChecks.length + 1;
        const unresolved = [];
        const finalize = () => {
          pending -= 1;
          if (pending === 0 && unresolved.length > 0) {
            logMigrationEvent('warn', 'company_id_backfill', 'Se omitio el relleno automatico de company_id porque la base tiene varias empresas y existen filas ambiguas.', {
              companies: rows.length,
              unresolved
            });
          }
        };

        if (typeof userUnresolvedTotal === 'number' && userUnresolvedTotal > 0) {
          unresolved.push({ table: 'users', total: userUnresolvedTotal });
        } else if (resolveErr) {
          db.get(
            `SELECT COUNT(*) AS total
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE u.company_id IS NULL OR c.id IS NULL`,
            (countErr, result) => {
            if (!countErr && result && Number(result.total) > 0) {
              unresolved.push({ table: 'users', total: Number(result.total) });
            }
            finalize();
            }
          );
          return;
        }
        finalize();

        tableChecks.forEach((table) => {
          db.get(`SELECT COUNT(*) AS total FROM ${table} WHERE company_id IS NULL`, (countErr, result) => {
            if (!countErr && result && Number(result.total) > 0) {
              unresolved.push({ table, total: Number(result.total) });
            }
            finalize();
          });
        });
      });
      return;
    }
    tables.forEach((table) => {
      if (table === 'users') {
        db.run(
          'UPDATE OR IGNORE users SET company_id = ? WHERE company_id IS NULL',
          [companyId],
          (updateErr) => {
            if (updateErr) {
              logMigrationEvent('warn', 'company_id_backfill', 'No se pudo actualizar company_id en users durante la migracion segura.', {
                companyId,
                error: updateErr.message || String(updateErr)
              });
            }
          }
        );
        return;
      }
      db.run(`UPDATE ${table} SET company_id = ? WHERE company_id IS NULL`, [companyId], (updateErr) => {
        if (updateErr) {
          logMigrationEvent('warn', 'company_id_backfill', 'No se pudo actualizar company_id en una tabla durante la migracion segura.', {
            table,
            companyId,
            error: updateErr.message || String(updateErr)
          });
        }
      });
    });
  });
}

function runSchema() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql, (err) => {
    if (err) console.error('[db/init] schema exec failed', err);
  });
}

function ensureIndexIfColumn(table, column, createSql) {
  tableExists(table, (exists) => {
    if (!exists) return;
    db.all(`PRAGMA table_info(${table})`, (err, columns) => {
      if (err || !columns) return;
      const hasColumn = columns.some((col) => col.name === column);
      if (hasColumn) {
        db.run(createSql);
      }
    });
  });
}

function ensureIndexIfColumns(table, requiredColumns, createSql) {
  tableExists(table, (exists) => {
    if (!exists) return;
    db.all(`PRAGMA table_info(${table})`, (err, columns) => {
      if (err || !columns) return;
      const names = new Set(columns.map((col) => col.name));
      const hasAll = requiredColumns.every((col) => names.has(col));
      if (hasAll) {
        db.run(createSql);
      }
    });
  });
}

function dedupeCatalogByCode(table, callback) {
  findDuplicateGroups(table, ['company_id', 'code'], { where: "code IS NOT NULL AND TRIM(code) != ''", limit: 10 }, (err, rows) => {
    if (err) {
      logMigrationEvent('warn', `${table}_code_duplicates`, 'No se pudo revisar duplicados de catalogo antes de la migracion segura.', {
        table,
        error: err.message || String(err)
      });
    } else if (rows.length > 0) {
      logMigrationEvent('warn', `${table}_code_duplicates`, 'Se detectaron codigos duplicados. La migracion segura no eliminara catalogos existentes.', {
        table,
        duplicates: rows
      });
    }
    if (callback) callback();
  });
}

function ensureCatalogCodeIndexes(table) {
  ensureIndexIfColumn(table, 'code', `CREATE INDEX IF NOT EXISTS idx_${table}_code ON ${table} (code)`);
  ensureUniqueIndexSafely(
    table,
    ['company_id', 'code'],
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_company_code ON ${table} (company_id, code)`,
    {
      scope: `${table}_company_code_unique`,
      where: "code IS NOT NULL AND TRIM(code) != ''",
      fallbackSql: `CREATE INDEX IF NOT EXISTS ix_${table}_company_code ON ${table} (company_id, code)`
    }
  );
}

function ensureIndexes() {
  db.run('CREATE INDEX IF NOT EXISTS idx_items_sku ON items (sku)');
  db.run('CREATE INDEX IF NOT EXISTS idx_items_category_id ON items (category_id)');
  ensureIndexIfColumn('items', 'brand_id', 'CREATE INDEX IF NOT EXISTS idx_items_brand_id ON items (brand_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_categories_name ON categories (name)');
  ensureIndexIfColumn('categories', 'code', 'CREATE INDEX IF NOT EXISTS idx_categories_code ON categories (code)');
  ensureIndexIfColumn('brands', 'name', 'CREATE INDEX IF NOT EXISTS idx_brands_name ON brands (name)');
  ensureIndexIfColumn('brands', 'code', 'CREATE INDEX IF NOT EXISTS idx_brands_code ON brands (code)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_company_id ON audit_logs (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name)');
  ensureIndexIfColumn('customers', 'document_number', 'CREATE INDEX IF NOT EXISTS idx_customers_document_number ON customers (document_number)');
  ensureIndexIfColumn('customers', 'advisor', 'CREATE INDEX IF NOT EXISTS idx_customers_advisor ON customers (advisor)');
  ensureIndexIfColumn('customers', 'payment_method', 'CREATE INDEX IF NOT EXISTS idx_customers_payment_method ON customers (payment_method)');
  ensureIndexIfColumn('customers', 'communication_type', 'CREATE INDEX IF NOT EXISTS idx_customers_communication_type ON customers (communication_type)');
  ensureIndexIfColumn('customers', 'customer_code', 'CREATE INDEX IF NOT EXISTS idx_customers_customer_code ON customers (customer_code)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices (customer_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices (created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items (invoice_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_items_company_id ON items (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_categories_company_id ON categories (company_id)');
  ensureIndexIfColumn('brands', 'company_id', 'CREATE INDEX IF NOT EXISTS idx_brands_company_id ON brands (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers (company_id)');
  ensureIndexIfColumn('customers', 'portal_code', 'CREATE INDEX IF NOT EXISTS idx_customers_portal_code ON customers (portal_code)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invoice_items_company_id ON invoice_items (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_users_company_id ON users (company_id)', (err) => {
    if (err) console.error('[ensureIndexes] create idx_users_company_id failed', err);
  });
  // Unique per-company indexes are handled separately with de-duplication.
  db.run('CREATE INDEX IF NOT EXISTS idx_package_photos_package_id ON package_photos (package_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_package_photos_company_id ON package_photos (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_package_status_package_id ON package_status_history (package_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_package_status_company_id ON package_status_history (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_package_comments_package_id ON package_comments (package_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_package_comments_company_id ON package_comments (company_id)');
  ensureIndexIfColumn(
    'carrier_receptions',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_carrier_receptions_company_id ON carrier_receptions (company_id)'
  );
  ensureIndexIfColumn(
    'carrier_receptions',
    'status',
    'CREATE INDEX IF NOT EXISTS idx_carrier_receptions_status ON carrier_receptions (status)'
  );
  ensureIndexIfColumn(
    'carrier_receptions',
    'tracking_number',
    'CREATE INDEX IF NOT EXISTS idx_carrier_receptions_tracking ON carrier_receptions (tracking_number)'
  );
  ensureIndexIfColumn(
    'carrier_receptions',
    'carrier',
    'CREATE INDEX IF NOT EXISTS idx_carrier_receptions_carrier ON carrier_receptions (carrier)'
  );
  ensureIndexIfColumn(
    'carrier_receptions',
    'received_at',
    'CREATE INDEX IF NOT EXISTS idx_carrier_receptions_received_at ON carrier_receptions (received_at)'
  );
  ensureIndexIfColumn(
    'carrier_receptions',
    'package_id',
    'CREATE INDEX IF NOT EXISTS idx_carrier_receptions_package_id ON carrier_receptions (package_id)'
  );
  ensureIndexIfColumn(
    'carrier_settings',
    'company_id',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_settings_company_id ON carrier_settings (company_id)'
  );
  ensureIndexIfColumn(
    'package_sender_settings',
    'company_id',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_package_sender_settings_company_id ON package_sender_settings (company_id)'
  );
  ensureIndexIfColumn(
    'consignatarios',
    'customer_id',
    'CREATE INDEX IF NOT EXISTS idx_consignatarios_customer_id ON consignatarios (customer_id)'
  );
  ensureIndexIfColumn(
    'consignatarios',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_consignatarios_company_id ON consignatarios (company_id)'
  );
  ensureIndexIfColumn(
    'consignatarios',
    'document_number',
    'CREATE INDEX IF NOT EXISTS idx_consignatarios_document_number ON consignatarios (document_number)'
  );
  ensureIndexIfColumn(
    'manifests',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_manifests_company_id ON manifests (company_id)'
  );
    ensureIndexIfColumn(
      'manifests',
      'status',
      'CREATE INDEX IF NOT EXISTS idx_manifests_status ON manifests (status)'
    );
    ensureIndexIfColumn(
      'awbs',
      'company_id',
      'CREATE INDEX IF NOT EXISTS idx_awbs_company_id ON awbs (company_id)'
    );
    ensureIndexIfColumn(
      'awbs',
      'status',
      'CREATE INDEX IF NOT EXISTS idx_awbs_status ON awbs (status)'
    );
    ensureIndexIfColumn(
      'awbs',
      'awb_number',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_awbs_company_awb_number ON awbs (company_id, awb_number)'
    );
    ensureIndexIfColumn(
      'awb_items',
      'awb_id',
      'CREATE INDEX IF NOT EXISTS idx_awb_items_awb_id ON awb_items (awb_id)'
    );
    ensureIndexIfColumn(
      'awb_manifests',
      'awb_id',
      'CREATE INDEX IF NOT EXISTS idx_awb_manifests_awb_id ON awb_manifests (awb_id)'
    );
    ensureIndexIfColumn(
      'awb_manifests',
      'manifest_id',
      'CREATE INDEX IF NOT EXISTS idx_awb_manifests_manifest_id ON awb_manifests (manifest_id)'
    );
  ensureIndexIfColumn(
    'manifest_pieces',
    'manifest_id',
    'CREATE INDEX IF NOT EXISTS idx_manifest_pieces_manifest_id ON manifest_pieces (manifest_id)'
  );
  ensureIndexIfColumn(
    'manifest_piece_packages',
    'manifest_piece_id',
    'CREATE INDEX IF NOT EXISTS idx_manifest_piece_packages_piece_id ON manifest_piece_packages (manifest_piece_id)'
  );
  ensureIndexIfColumn(
    'manifest_piece_packages',
    'package_id',
    'CREATE INDEX IF NOT EXISTS idx_manifest_piece_packages_package_id ON manifest_piece_packages (package_id)'
  );
  ensureIndexIfColumn(
    'cuscar_transporters',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transporters_company_id ON cuscar_transporters (company_id)'
  );
  dedupeCatalogByCode('cuscar_transporters', () => ensureCatalogCodeIndexes('cuscar_transporters'));
  ensureIndexIfColumn(
    'cuscar_consignatarios',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_consignatarios_company_id ON cuscar_consignatarios (company_id)'
  );
  dedupeCatalogByCode('cuscar_consignatarios', () => ensureCatalogCodeIndexes('cuscar_consignatarios'));
  ensureIndexIfColumn(
    'cuscar_remitentes',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_remitentes_company_id ON cuscar_remitentes (company_id)'
  );
  dedupeCatalogByCode('cuscar_remitentes', () => ensureCatalogCodeIndexes('cuscar_remitentes'));
  ensureIndexIfColumn(
    'cuscar_airlines',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_airlines_company_id ON cuscar_airlines (company_id)'
  );
  dedupeCatalogByCode('cuscar_airlines', () => ensureCatalogCodeIndexes('cuscar_airlines'));
  ensureIndexIfColumn(
    'cuscar_ports',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_ports_company_id ON cuscar_ports (company_id)'
  );
  dedupeCatalogByCode('cuscar_ports', () => ensureCatalogCodeIndexes('cuscar_ports'));
  ensureIndexIfColumn(
    'cuscar_countries',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_countries_company_id ON cuscar_countries (company_id)'
  );
  dedupeCatalogByCode('cuscar_countries', () => ensureCatalogCodeIndexes('cuscar_countries'));
  ensureIndexIfColumn(
    'cuscar_package_types',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_package_types_company_id ON cuscar_package_types (company_id)'
  );
  dedupeCatalogByCode('cuscar_package_types', () => ensureCatalogCodeIndexes('cuscar_package_types'));
  ensureIndexIfColumn(
    'cuscar_units',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_units_company_id ON cuscar_units (company_id)'
  );
  dedupeCatalogByCode('cuscar_units', () => ensureCatalogCodeIndexes('cuscar_units'));
  ensureIndexIfColumn(
    'cuscar_customs_offices',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_customs_offices_company_id ON cuscar_customs_offices (company_id)'
  );
  dedupeCatalogByCode('cuscar_customs_offices', () => ensureCatalogCodeIndexes('cuscar_customs_offices'));
  ensureIndexIfColumn(
    'cuscar_airports',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_airports_company_id ON cuscar_airports (company_id)'
  );
  dedupeCatalogByCode('cuscar_airports', () => ensureCatalogCodeIndexes('cuscar_airports'));
  ensureIndexIfColumn(
    'cuscar_transport_modes',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transport_modes_company_id ON cuscar_transport_modes (company_id)'
  );
  dedupeCatalogByCode('cuscar_transport_modes', () => ensureCatalogCodeIndexes('cuscar_transport_modes'));
  ensureIndexIfColumn(
    'cuscar_transport_means',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transport_means_company_id ON cuscar_transport_means (company_id)'
  );
  dedupeCatalogByCode('cuscar_transport_means', () => ensureCatalogCodeIndexes('cuscar_transport_means'));
  ensureIndexIfColumn(
    'cuscar_message_types',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_message_types_company_id ON cuscar_message_types (company_id)'
  );
  dedupeCatalogByCode('cuscar_message_types', () => ensureCatalogCodeIndexes('cuscar_message_types'));
  ensureIndexIfColumn(
    'cuscar_message_functions',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_message_functions_company_id ON cuscar_message_functions (company_id)'
  );
  dedupeCatalogByCode('cuscar_message_functions', () => ensureCatalogCodeIndexes('cuscar_message_functions'));
  ensureIndexIfColumn(
    'cuscar_reference_qualifiers',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_reference_qualifiers_company_id ON cuscar_reference_qualifiers (company_id)'
  );
  dedupeCatalogByCode('cuscar_reference_qualifiers', () => ensureCatalogCodeIndexes('cuscar_reference_qualifiers'));
  ensureIndexIfColumn(
    'cuscar_message_responsibles',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_message_responsibles_company_id ON cuscar_message_responsibles (company_id)'
  );
  dedupeCatalogByCode('cuscar_message_responsibles', () => ensureCatalogCodeIndexes('cuscar_message_responsibles'));
  ensureIndexIfColumn(
    'cuscar_transport_id_agencies',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transport_id_agencies_company_id ON cuscar_transport_id_agencies (company_id)'
  );
  dedupeCatalogByCode('cuscar_transport_id_agencies', () => ensureCatalogCodeIndexes('cuscar_transport_id_agencies'));
  ensureIndexIfColumn(
    'cuscar_manifests',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_manifests_company_id ON cuscar_manifests (company_id)'
  );
  ensureIndexIfColumn(
    'cuscar_manifests',
    'status',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_manifests_status ON cuscar_manifests (status)'
  );
  ensureIndexIfColumn(
    'cuscar_manifests',
    'internal_number',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cuscar_manifests_company_internal ON cuscar_manifests (company_id, internal_number)'
  );
  ensureIndexIfColumn(
    'cuscar_manifest_items',
    'manifest_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_manifest_items_manifest_id ON cuscar_manifest_items (manifest_id)'
  );
  ensureIndexIfColumn(
    'cuscar_manifest_items',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_manifest_items_company_id ON cuscar_manifest_items (company_id)'
  );
  ensureIndexIfColumn(
    'cuscar_transmissions',
    'company_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transmissions_company_id ON cuscar_transmissions (company_id)'
  );
  ensureIndexIfColumn(
    'cuscar_transmissions',
    'manifest_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transmissions_manifest_id ON cuscar_transmissions (manifest_id)'
  );
  ensureIndexIfColumn(
    'cuscar_transmissions',
    'status',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transmissions_status ON cuscar_transmissions (status)'
  );
  ensureIndexIfColumn(
    'cuscar_transmission_responses',
    'transmission_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transmission_responses_tx ON cuscar_transmission_responses (transmission_id)'
  );
  ensureIndexIfColumn(
    'cuscar_transmission_errors',
    'transmission_id',
    'CREATE INDEX IF NOT EXISTS idx_cuscar_transmission_errors_tx ON cuscar_transmission_errors (transmission_id)'
  );
}

function ensurePackageIndexes(table) {
  if (!table) return;
  ensureIndexIfColumn(table, 'company_id', `CREATE INDEX IF NOT EXISTS idx_${table}_company_id ON ${table} (company_id)`);
  ensureIndexIfColumn(table, 'status', `CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table} (status)`);
  ensureIndexIfColumn(table, 'tracking_number', `CREATE INDEX IF NOT EXISTS idx_${table}_tracking ON ${table} (tracking_number)`);
  ensureIndexIfColumn(table, 'carrier', `CREATE INDEX IF NOT EXISTS idx_${table}_carrier ON ${table} (carrier)`);
  ensureIndexIfColumn(table, 'customer_id', `CREATE INDEX IF NOT EXISTS idx_${table}_customer_id ON ${table} (customer_id)`);
  ensureIndexIfColumn(table, 'consignatario_id', `CREATE INDEX IF NOT EXISTS idx_${table}_consignatario_id ON ${table} (consignatario_id)`);
  ensureIndexIfColumn(table, 'received_at', `CREATE INDEX IF NOT EXISTS idx_${table}_received_at ON ${table} (received_at)`);
  ensureIndexIfColumns(
    table,
    ['company_id', 'internal_code'],
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_company_internal_code ON ${table} (company_id, internal_code)`
  );
}

function ensurePackageColumnsAndIndexes(callback) {
  findPackagesTable((table) => {
    if (!table) {
      if (callback) callback(null);
      return;
    }
    const columns = [
        { name: 'internal_code', type: 'TEXT' },
        { name: 'customer_id', type: 'INTEGER' },
        { name: 'consignatario_id', type: 'INTEGER' },
        { name: 'sender_name', type: 'TEXT' },
      { name: 'store_name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'delivery_address', type: 'TEXT' },
      { name: 'delivery_municipality', type: 'TEXT' },
      { name: 'delivery_department', type: 'TEXT' },
      { name: 'delivery_phone', type: 'TEXT' },
      { name: 'weight_lbs', type: 'REAL' },
      { name: 'length_cm', type: 'REAL' },
      { name: 'width_cm', type: 'REAL' },
      { name: 'height_cm', type: 'REAL' },
      { name: 'declared_value', type: 'REAL' },
      { name: 'shipping_type', type: 'TEXT' },
      { name: 'branch_destination', type: 'TEXT' },
      { name: 'delivery_type', type: 'TEXT' },
      { name: 'payment_status', type: "TEXT DEFAULT 'pending'" },
      { name: 'invoice_status', type: "TEXT DEFAULT 'pending'" },
      { name: 'carrier', type: 'TEXT' },
      { name: 'tracking_number', type: 'TEXT' },
      { name: 'received_at', type: 'DATETIME' },
      { name: 'invoice_file', type: 'TEXT' },
      { name: 'notes', type: 'TEXT' },
      { name: 'status', type: "TEXT DEFAULT 'Recibido en bodega USA'" },
      { name: 'company_id', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ];
    ensureColumnsOnTable(table, columns, () => {
      ensurePackageIndexes(table);
      if (callback) callback(table);
    });
  });
}

function migrateUsersRole() {
  db.all('PRAGMA table_info(users)', (err, columns) => {
    if (err || !columns) return;
    const hasRole = columns.some((col) => col.name === 'role');
    if (!hasRole) {
      //db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'employee'");
    }
  });
}




function migrateItemsCategory() {
  db.all('PRAGMA table_info(items)', (err, columns) => {
    if (err || !columns) return;
    const hasCategory = columns.some((col) => col.name === 'category_id');
    if (!hasCategory) {
     // db.run('ALTER TABLE items ADD COLUMN category_id INTEGER NULL');
    }
  });
}

function migrateItemsMinStock() {
  db.all('PRAGMA table_info(items)', (err, columns) => {
    if (err || !columns) return;
    const hasMinStock = columns.some((col) => col.name === 'min_stock');
    if (!hasMinStock) {
      db.run('ALTER TABLE items ADD COLUMN min_stock INTEGER NOT NULL DEFAULT 5');
    }
  });
}

function migrateCompanyIdColumns() {
  const tables = ['products', 'users', 'invoices', 'categories', 'brands', 'items'];
  tables.forEach((table) => {
    ensureColumn(table, 'company_id', 'INTEGER NULL');
  });
}

function logAction(userId, action, details, companyId) {
  const resolvedCompanyId = Number.isInteger(companyId) && companyId > 0 ? companyId : null;
  db.run(
    'INSERT INTO audit_logs (user_id, action, details, company_id) VALUES (?, ?, ?, ?)',
    [userId || null, action, details || null, resolvedCompanyId]
  );
}

db.serialize(() => {
  ensureMigrationLogTable();

 db.run(`
 CREATE TABLE IF NOT EXISTS companies (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT,
 legal_name TEXT,
 address TEXT,
 tax_address TEXT,
 nit TEXT,
 employees INTEGER,
 business_type TEXT,
 currency TEXT,
 email TEXT,
 phone TEXT,
 username TEXT,
 password_hash TEXT,
 accounting_framework TEXT,
 logo TEXT,
 primary_color TEXT,
 secondary_color TEXT,
 theme_background_color TEXT,
 theme_title_color TEXT,
 theme_text_color TEXT,
 theme_font_family TEXT,
 theme_logo_size INTEGER,
 theme_icon_size INTEGER,
 theme_icon_frame INTEGER,
 active_from DATETIME,
 active_until DATETIME,
 inactive_reason TEXT,
 is_active INTEGER NOT NULL DEFAULT 1,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)

`);

  db.run(
    `CREATE TABLE IF NOT EXISTS company_inactivation_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      note_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_company_inactivation_notes_company ON company_inactivation_notes (company_id)');

  db.run(
    `CREATE TABLE IF NOT EXISTS permission_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS permission_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS module_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id INTEGER NOT NULL,
      action_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(module_id, action_id),
      FOREIGN KEY (module_id) REFERENCES permission_modules(id),
      FOREIGN KEY (action_id) REFERENCES permission_actions(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      module_id INTEGER NOT NULL,
      action_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, module_id, action_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (module_id) REFERENCES permission_modules(id),
      FOREIGN KEY (action_id) REFERENCES permission_actions(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS business_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      modules_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run('CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions (user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_permissions_company ON user_permissions (company_id)');

  db.run(
    `CREATE TABLE IF NOT EXISTS user_workspace_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      dock_enabled INTEGER NOT NULL DEFAULT 1,
      dock_position TEXT NOT NULL DEFAULT 'left',
      dock_mode TEXT NOT NULL DEFAULT 'auto-hide',
      dock_auto_hide INTEGER NOT NULL DEFAULT 1,
      dock_size INTEGER NULL,
      show_labels INTEGER NOT NULL DEFAULT 1,
      theme_color TEXT NULL,
      accent_color TEXT NULL,
      background_color TEXT NULL,
      dock_color TEXT NULL,
      dock_modules TEXT NULL,
      icon_style TEXT NULL,
      icon_size INTEGER NULL,
      use_glass_effect INTEGER NOT NULL DEFAULT 1,
      layout_mode TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, company_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_user_workspace_settings_user ON user_workspace_settings (user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_workspace_settings_company ON user_workspace_settings (company_id)');

  db.run(
    `CREATE TABLE IF NOT EXISTS user_workspace_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      module_key TEXT NULL,
      folder_name TEXT NULL,
      icon_name TEXT NULL,
      color TEXT NULL,
      pos_x REAL NULL,
      pos_y REAL NULL,
      sort_order INTEGER NULL,
      parent_folder_id INTEGER NULL,
      is_visible INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (company_id) REFERENCES companies(id),
      FOREIGN KEY (parent_folder_id) REFERENCES user_workspace_items(id)
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_user_workspace_items_user ON user_workspace_items (user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_workspace_items_company ON user_workspace_items (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_workspace_items_parent ON user_workspace_items (parent_folder_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_user_workspace_items_module ON user_workspace_items (company_id, user_id, module_key)');

  db.run(
    `CREATE TABLE IF NOT EXISTS package_label_layouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL UNIQUE,
      layout_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_package_label_layouts_company ON package_label_layouts (company_id)');

  db.run(
    `CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      paciente_nombre TEXT NOT NULL,
      telefono TEXT,
      motivo TEXT,
      doctor_id INTEGER NOT NULL,
      fecha_hora TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      duration_min INTEGER NOT NULL DEFAULT 30,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_appointments_company_date ON appointments (company_id, fecha_hora)');
  db.run('CREATE INDEX IF NOT EXISTS idx_appointments_company_doctor ON appointments (company_id, doctor_id)');

  db.run(
    `CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      specialty TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id)
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_doctors_company ON doctors (company_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_doctors_company_active ON doctors (company_id, is_active)');

  migrateUsersRole();
  migrateItemsCategory();
  migrateItemsMinStock();
  migrateCompanyIdColumns();
  runSchema();
  seedAiHelpModules();

  ensureCompanyAccountingColumns(() => {
    applyCompanyDefaults();
    ensureInvoiceCurrencyColumns();
    seedNifCatalogForAllCompanies();
  });

  ensureColumn('companies', 'username', 'TEXT');
  ensureColumn('companies', 'password_hash', 'TEXT');
  ensureColumn('companies', 'created_at', 'DATETIME');
  ensureColumn('companies', 'active_from', 'DATETIME');
  ensureColumn('companies', 'active_until', 'DATETIME');
  ensureColumn('companies', 'logo', 'TEXT');
  ensureColumn('companies', 'phone', 'TEXT');
  ensureColumn('companies', 'email', 'TEXT');
  ensureColumn('companies', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('companies', 'inactive_reason', 'TEXT');
  ensureColumnsOnTable('companies', [
    { name: 'legal_name', type: 'TEXT' },
    { name: 'tax_address', type: 'TEXT' },
    { name: 'activity_id', type: 'INTEGER' },
    { name: 'allowed_modules', type: 'TEXT' },
    { name: 'theme_background_color', type: 'TEXT' },
    { name: 'theme_title_color', type: 'TEXT' },
    { name: 'theme_text_color', type: 'TEXT' },
    { name: 'theme_font_family', type: 'TEXT' },
    { name: 'theme_logo_size', type: 'INTEGER' },
    { name: 'theme_icon_size', type: 'INTEGER' },
    { name: 'theme_icon_frame', type: 'INTEGER' },
    { name: 'contact_general_first_name', type: 'TEXT' },
    { name: 'contact_general_last_name', type: 'TEXT' },
    { name: 'contact_general_phone', type: 'TEXT' },
    { name: 'contact_general_mobile', type: 'TEXT' },
    { name: 'contact_general_email', type: 'TEXT' },
    { name: 'contact_general_position', type: 'TEXT' },
    { name: 'contact_payments_first_name', type: 'TEXT' },
    { name: 'contact_payments_last_name', type: 'TEXT' },
    { name: 'contact_payments_phone', type: 'TEXT' },
    { name: 'contact_payments_mobile', type: 'TEXT' },
    { name: 'contact_payments_email', type: 'TEXT' },
    { name: 'contact_payments_position', type: 'TEXT' },
    { name: 'contact_ops_first_name', type: 'TEXT' },
    { name: 'contact_ops_last_name', type: 'TEXT' },
    { name: 'contact_ops_phone', type: 'TEXT' },
    { name: 'contact_ops_mobile', type: 'TEXT' },
    { name: 'contact_ops_email', type: 'TEXT' },
    { name: 'contact_ops_position', type: 'TEXT' },
    { name: 'admin_name', type: 'TEXT' },
    { name: 'admin_position', type: 'TEXT' },
    { name: 'active_mode', type: 'TEXT' }
  ]);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_username ON companies (username)');

  ensureColumn('users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumnsOnTable(
    'user_workspace_settings',
    [
      { name: 'dock_enabled', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'dock_position', type: "TEXT NOT NULL DEFAULT 'left'" },
      { name: 'dock_mode', type: "TEXT NOT NULL DEFAULT 'auto-hide'" },
      { name: 'dock_auto_hide', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'dock_size', type: 'INTEGER' },
      { name: 'show_labels', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'theme_color', type: 'TEXT' },
      { name: 'accent_color', type: 'TEXT' },
      { name: 'background_color', type: 'TEXT' },
      { name: 'dock_color', type: 'TEXT' },
      { name: 'dock_modules', type: 'TEXT' },
      { name: 'icon_style', type: 'TEXT' },
      { name: 'icon_size', type: 'INTEGER' },
      { name: 'use_glass_effect', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'layout_mode', type: 'TEXT' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );
  ensureColumnsOnTable(
    'user_workspace_items',
    [
      { name: 'item_type', type: 'TEXT' },
      { name: 'module_key', type: 'TEXT' },
      { name: 'folder_name', type: 'TEXT' },
      { name: 'icon_name', type: 'TEXT' },
      { name: 'color', type: 'TEXT' },
      { name: 'pos_x', type: 'REAL' },
      { name: 'pos_y', type: 'REAL' },
      { name: 'sort_order', type: 'INTEGER' },
      { name: 'parent_folder_id', type: 'INTEGER' },
      { name: 'is_visible', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );
  ensureColumn('items', 'company_id', 'INTEGER');
  ensureColumnsOnTable(
    'items',
    [
      { name: 'item_code', type: 'TEXT' },
      { name: 'code_manual', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'brand_id', type: 'INTEGER' },
      { name: 'warehouse_location', type: 'TEXT' },
      { name: 'barcode', type: 'TEXT' }
    ]
  );
  ensureColumnsOnTable(
    'categories',
    [
      { name: 'code', type: 'TEXT' },
      { name: 'code_manual', type: 'INTEGER NOT NULL DEFAULT 0' }
    ]
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NULL,
      code_manual INTEGER NOT NULL DEFAULT 0,
      company_id INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  ensureColumnsOnTable(
    'brands',
    [
      { name: 'name', type: 'TEXT' },
      { name: 'code', type: 'TEXT' },
      { name: 'code_manual', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'company_id', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_company_name ON brands (company_id, name)');
  ensureColumn('customers', 'company_id', 'INTEGER');
  ensureCustomerPortalColumns();
  ensureColumnsOnTable(
    'customers',
    [
      { name: 'customer_code', type: 'TEXT' },
      { name: 'first_name', type: 'TEXT' },
      { name: 'last_name', type: 'TEXT' },
      { name: 'document_type', type: 'TEXT' },
      { name: 'document_number', type: 'TEXT' },
      { name: 'full_address', type: 'TEXT' },
      { name: 'house_number', type: 'TEXT' },
      { name: 'street_number', type: 'TEXT' },
      { name: 'zone', type: 'TEXT' },
      { name: 'municipality', type: 'TEXT' },
      { name: 'department', type: 'TEXT' },
      { name: 'country', type: 'TEXT' },
      { name: 'mobile', type: 'TEXT' },
      { name: 'payment_method', type: 'TEXT' },
      { name: 'communication_type', type: 'TEXT' },
      { name: 'advisor', type: 'TEXT' },
      { name: 'notes', type: 'TEXT' },
      { name: 'is_voided', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'voided_at', type: 'DATETIME' },
      { name: 'voided_by', type: 'INTEGER' },
      { name: 'sat_verified', type: 'INTEGER DEFAULT 0' },
      { name: 'sat_name', type: 'TEXT' },
      { name: 'sat_checked_at', type: 'DATETIME' }
    ]
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS consignatarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      company_id INTEGER NULL,
      document_type TEXT,
      document_number TEXT,
      name TEXT NOT NULL,
      full_address TEXT,
      zone TEXT,
      municipality TEXT,
      department TEXT,
      country TEXT,
      phone TEXT,
      mobile TEXT,
      email TEXT,
      sat_verified INTEGER DEFAULT 0,
      sat_name TEXT,
      sat_checked_at DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )`
  );
  ensureColumnsOnTable(
    'consignatarios',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'document_type', type: 'TEXT' },
      { name: 'document_number', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'full_address', type: 'TEXT' },
      { name: 'zone', type: 'TEXT' },
      { name: 'municipality', type: 'TEXT' },
      { name: 'department', type: 'TEXT' },
      { name: 'country', type: 'TEXT' },
      { name: 'phone', type: 'TEXT' },
      { name: 'mobile', type: 'TEXT' },
      { name: 'email', type: 'TEXT' },
      { name: 'sat_verified', type: 'INTEGER DEFAULT 0' },
      { name: 'sat_name', type: 'TEXT' },
      { name: 'sat_checked_at', type: 'DATETIME' },
      { name: 'notes', type: 'TEXT' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );
  ensureColumn('invoice_items', 'company_id', 'INTEGER');
  ensureColumn('invoice_items', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
  ensureColumn('audit_logs', 'company_id', 'INTEGER');
  ensureColumn('package_status_history', 'old_status', 'TEXT');
  ensureColumn('package_status_history', 'new_status', 'TEXT');
  ensureColumn('package_status_history', 'notes', 'TEXT');
  ensureColumn('package_status_history', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
  ensureColumn('package_photos', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
  db.run(
    `CREATE TABLE IF NOT EXISTS package_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      comment TEXT NOT NULL,
      created_by INTEGER NULL,
      company_id INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS carrier_receptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      tracking_number TEXT NOT NULL,
      carrier TEXT NOT NULL,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      received_by TEXT NULL,
      notes TEXT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      package_id INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS carrier_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      carriers_text TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS package_sender_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      sender_name TEXT NULL,
      store_name TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      airway_bill_number TEXT NULL,
      notes TEXT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER NULL,
      closed_by INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME NULL,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (closed_by) REFERENCES users(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS awbs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      awb_type TEXT NULL,
      awb_number TEXT NOT NULL,
      awb_date TEXT NULL,
      issuing_carrier TEXT NULL,
      agent_name TEXT NULL,
      agent_iata_code TEXT NULL,
      agent_cass_code TEXT NULL,
      shipper_name TEXT NULL,
      shipper_address TEXT NULL,
      consignee_name TEXT NULL,
      consignee_address TEXT NULL,
      accounting_information TEXT NULL,
      reference_number TEXT NULL,
      optional_shipping_info_1 TEXT NULL,
      optional_shipping_info_2 TEXT NULL,
      airport_of_departure TEXT NULL,
      airport_of_destination TEXT NULL,
      carrier_code TEXT NULL,
      flight_number TEXT NULL,
      departure_airport TEXT NULL,
      departure_date TEXT NULL,
      arrival_airport TEXT NULL,
      arrival_date TEXT NULL,
      currency TEXT NULL,
      charges_code TEXT NULL,
      weight_valuation_charge_type TEXT NULL,
      other_charges_type TEXT NULL,
      declared_value_carriage TEXT NULL,
      declared_value_customs TEXT NULL,
      insurance_amount REAL NULL,
      handling_information TEXT NULL,
      special_handling_details TEXT NULL,
      ssr TEXT NULL,
      osi TEXT NULL,
      total_pieces INTEGER NULL,
      gross_weight REAL NULL,
      chargeable_weight REAL NULL,
      goods_description TEXT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS awb_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      awb_id INTEGER NOT NULL,
      pieces INTEGER NULL,
      gross_weight REAL NULL,
      dimensions TEXT NULL,
      goods_description TEXT NULL,
      rate_class TEXT NULL,
      chargeable_weight REAL NULL,
      rate REAL NULL,
      total REAL NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (awb_id) REFERENCES awbs(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS awb_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      awb_id INTEGER NOT NULL,
      manifest_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (awb_id, manifest_id),
      FOREIGN KEY (awb_id) REFERENCES awbs(id),
      FOREIGN KEY (manifest_id) REFERENCES manifests(id)
    )`
  );

  ensureColumnsOnTable(
    'awbs',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'awb_type', type: 'TEXT' },
      { name: 'awb_number', type: 'TEXT' },
      { name: 'awb_date', type: 'TEXT' },
      { name: 'issuing_carrier', type: 'TEXT' },
      { name: 'agent_name', type: 'TEXT' },
      { name: 'agent_iata_code', type: 'TEXT' },
      { name: 'agent_cass_code', type: 'TEXT' },
      { name: 'shipper_name', type: 'TEXT' },
      { name: 'shipper_address', type: 'TEXT' },
      { name: 'consignee_name', type: 'TEXT' },
      { name: 'consignee_address', type: 'TEXT' },
      { name: 'accounting_information', type: 'TEXT' },
      { name: 'reference_number', type: 'TEXT' },
      { name: 'optional_shipping_info_1', type: 'TEXT' },
      { name: 'optional_shipping_info_2', type: 'TEXT' },
      { name: 'airport_of_departure', type: 'TEXT' },
      { name: 'airport_of_destination', type: 'TEXT' },
      { name: 'carrier_code', type: 'TEXT' },
      { name: 'flight_number', type: 'TEXT' },
      { name: 'departure_airport', type: 'TEXT' },
      { name: 'departure_date', type: 'TEXT' },
      { name: 'arrival_airport', type: 'TEXT' },
      { name: 'arrival_date', type: 'TEXT' },
      { name: 'currency', type: 'TEXT' },
      { name: 'charges_code', type: 'TEXT' },
      { name: 'weight_valuation_charge_type', type: 'TEXT' },
      { name: 'other_charges_type', type: 'TEXT' },
      { name: 'declared_value_carriage', type: 'TEXT' },
      { name: 'declared_value_customs', type: 'TEXT' },
      { name: 'insurance_amount', type: 'REAL' },
      { name: 'handling_information', type: 'TEXT' },
      { name: 'special_handling_details', type: 'TEXT' },
      { name: 'ssr', type: 'TEXT' },
      { name: 'osi', type: 'TEXT' },
      { name: 'total_pieces', type: 'INTEGER' },
      { name: 'gross_weight', type: 'REAL' },
      { name: 'chargeable_weight', type: 'REAL' },
      { name: 'goods_description', type: 'TEXT' },
      { name: 'status', type: "TEXT NOT NULL DEFAULT 'draft'" },
      { name: 'created_by', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'awb_items',
    [
      { name: 'awb_id', type: 'INTEGER' },
      { name: 'pieces', type: 'INTEGER' },
      { name: 'gross_weight', type: 'REAL' },
      { name: 'dimensions', type: 'TEXT' },
      { name: 'goods_description', type: 'TEXT' },
      { name: 'rate_class', type: 'TEXT' },
      { name: 'chargeable_weight', type: 'REAL' },
      { name: 'rate', type: 'REAL' },
      { name: 'total', type: 'REAL' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'awb_manifests',
    [
      { name: 'awb_id', type: 'INTEGER' },
      { name: 'manifest_id', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS manifest_pieces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_id INTEGER NOT NULL,
      piece_number INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (manifest_id) REFERENCES manifests(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS manifest_piece_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_piece_id INTEGER NOT NULL,
      package_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (manifest_piece_id) REFERENCES manifest_pieces(id),
      FOREIGN KEY (package_id) REFERENCES packages(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transporters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_consignatarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_remitentes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_airlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_ports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_countries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_package_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_customs_offices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_airports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transport_modes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transport_means (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_message_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_message_functions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_reference_qualifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_message_responsibles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transport_id_agencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      code TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      source TEXT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      internal_number TEXT NOT NULL,
      master_airway_bill TEXT NOT NULL,
      flight_number TEXT NOT NULL,
      flight_date TEXT NOT NULL,
      airline_id INTEGER NOT NULL,
      transport_mode_id INTEGER NULL,
      transport_means_id INTEGER NULL,
      message_type_id INTEGER NULL,
      message_function_id INTEGER NULL,
      message_responsible_id INTEGER NULL,
      reference_qualifier_id INTEGER NULL,
      transport_id_agency_id INTEGER NULL,
      origin_airport_id INTEGER NULL,
      origin_port_id INTEGER NOT NULL,
      destination_airport_id INTEGER NULL,
      destination_port_id INTEGER NOT NULL,
      customs_port_id INTEGER NOT NULL,
      customs_office_id INTEGER NULL,
      transporter_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      observations TEXT NULL,
      preview_text TEXT NULL,
      preview_generated_at DATETIME NULL,
      preview_generated_by INTEGER NULL,
      created_by INTEGER NULL,
      closed_by INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME NULL,
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (closed_by) REFERENCES users(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_manifest_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      hawb_number TEXT NOT NULL,
      shipper_id INTEGER NOT NULL,
      consignee_id INTEGER NOT NULL,
      goods_description TEXT NOT NULL,
      package_qty INTEGER NOT NULL DEFAULT 0,
      package_type_id INTEGER NOT NULL,
      weight_unit_id INTEGER NULL,
      gross_weight REAL NOT NULL DEFAULT 0,
      net_weight REAL NOT NULL DEFAULT 0,
      declared_value REAL NOT NULL DEFAULT 0,
      origin_country_id INTEGER NOT NULL,
      observations TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (manifest_id) REFERENCES cuscar_manifests(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transmissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      manifest_id INTEGER NOT NULL,
      payload_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      mode TEXT NOT NULL DEFAULT 'simulation',
      endpoint TEXT NULL,
      requested_by INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (manifest_id) REFERENCES cuscar_manifests(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transmission_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transmission_id INTEGER NOT NULL,
      response_code TEXT NULL,
      response_message TEXT NULL,
      raw_response TEXT NULL,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transmission_id) REFERENCES cuscar_transmissions(id)
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS cuscar_transmission_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transmission_id INTEGER NOT NULL,
      error_message TEXT NOT NULL,
      error_detail TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transmission_id) REFERENCES cuscar_transmissions(id)
    )`
  );

  ensureColumnsOnTable(
    'cuscar_transporters',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_consignatarios',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_remitentes',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_airlines',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_ports',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_countries',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_package_types',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_units',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_customs_offices',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_airports',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_transport_modes',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_transport_means',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_message_types',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_message_functions',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_reference_qualifiers',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_message_responsibles',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_transport_id_agencies',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'code', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'source', type: 'TEXT' },
      { name: 'sort_order', type: 'INTEGER DEFAULT 0' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_manifests',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'internal_number', type: 'TEXT' },
      { name: 'master_airway_bill', type: 'TEXT' },
      { name: 'flight_number', type: 'TEXT' },
      { name: 'flight_date', type: 'TEXT' },
      { name: 'airline_id', type: 'INTEGER' },
      { name: 'transport_mode_id', type: 'INTEGER' },
      { name: 'transport_means_id', type: 'INTEGER' },
      { name: 'message_type_id', type: 'INTEGER' },
      { name: 'message_function_id', type: 'INTEGER' },
      { name: 'message_responsible_id', type: 'INTEGER' },
      { name: 'reference_qualifier_id', type: 'INTEGER' },
      { name: 'transport_id_agency_id', type: 'INTEGER' },
      { name: 'origin_airport_id', type: 'INTEGER' },
      { name: 'origin_port_id', type: 'INTEGER' },
      { name: 'destination_airport_id', type: 'INTEGER' },
      { name: 'destination_port_id', type: 'INTEGER' },
      { name: 'customs_port_id', type: 'INTEGER' },
      { name: 'customs_office_id', type: 'INTEGER' },
      { name: 'transporter_id', type: 'INTEGER' },
      { name: 'status', type: "TEXT NOT NULL DEFAULT 'draft'" },
      { name: 'observations', type: 'TEXT' },
      { name: 'preview_text', type: 'TEXT' },
      { name: 'preview_generated_at', type: 'DATETIME' },
      { name: 'preview_generated_by', type: 'INTEGER' },
      { name: 'created_by', type: 'INTEGER' },
      { name: 'closed_by', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'closed_at', type: 'DATETIME' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_manifest_items',
    [
      { name: 'manifest_id', type: 'INTEGER' },
      { name: 'company_id', type: 'INTEGER' },
      { name: 'hawb_number', type: 'TEXT' },
      { name: 'shipper_id', type: 'INTEGER' },
      { name: 'consignee_id', type: 'INTEGER' },
      { name: 'goods_description', type: 'TEXT' },
      { name: 'package_qty', type: 'INTEGER' },
      { name: 'package_type_id', type: 'INTEGER' },
      { name: 'weight_unit_id', type: 'INTEGER' },
      { name: 'gross_weight', type: 'REAL' },
      { name: 'net_weight', type: 'REAL' },
      { name: 'declared_value', type: 'REAL' },
      { name: 'origin_country_id', type: 'INTEGER' },
      { name: 'observations', type: 'TEXT' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_transmissions',
    [
      { name: 'company_id', type: 'INTEGER' },
      { name: 'manifest_id', type: 'INTEGER' },
      { name: 'payload_text', type: 'TEXT' },
      { name: 'status', type: "TEXT NOT NULL DEFAULT 'pending'" },
      { name: 'mode', type: "TEXT NOT NULL DEFAULT 'simulation'" },
      { name: 'endpoint', type: 'TEXT' },
      { name: 'requested_by', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_transmission_responses',
    [
      { name: 'transmission_id', type: 'INTEGER' },
      { name: 'response_code', type: 'TEXT' },
      { name: 'response_message', type: 'TEXT' },
      { name: 'raw_response', type: 'TEXT' },
      { name: 'received_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureColumnsOnTable(
    'cuscar_transmission_errors',
    [
      { name: 'transmission_id', type: 'INTEGER' },
      { name: 'error_message', type: 'TEXT' },
      { name: 'error_detail', type: 'TEXT' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ]
  );

  ensureAccountingTables();
  ensureAccountingOperationsTables();
  ensureNifAccountingTables();
  ensureColumnsOnTable('appointments', [
    { name: 'duration_min', type: 'INTEGER NOT NULL DEFAULT 30' }
  ]);
  ensureColumnsOnTable('doctors', [
    { name: 'name', type: 'TEXT' },
    { name: 'phone', type: 'TEXT' },
    { name: 'specialty', type: 'TEXT' },
    { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' }
  ]);
  backfillJournalBaseAmounts();
  ensureIndexes();
  seedCuscarBaseCatalogs({ onlyIfEmpty: true });
  dedupeUsers(() => ensureUsersPerCompanyUnique());
  ensureCategoriesPerCompanyUnique();
  backfillCompanyIdForExisting();
  ensurePackageColumnsAndIndexes(() => {
    backfillPackageInternalCodes();
    backfillPackageDefaults();
  });
  backfillCustomerPortalCodes();
  backfillCustomerCodes();

  db.serialize(() => {
    db.run(
      `INSERT OR IGNORE INTO permission_modules (code, name, description) VALUES
      ('dashboard','Dashboard','Panel principal'),
      ('packages','Paquetes','GestiÃ³n de paquetes'),
      ('carrier_reception','Recepcion de paquetes de carrier','Recepcion rÃ¡pida de paquetes carrier'),
      ('customers','Clientes','GestiÃ³n de clientes'),
      ('consignatarios','Consignatarios','GestiÃ³n de consignatarios'),
      ('billing','FacturaciÃ³n','FacturaciÃ³n y cobros'),
      ('accounting','Contabilidad','Contabilidad y finanzas'),
      ('agenda_medica','Agenda Medica','Citas y calendario medico'),
      ('portal','Portal clientes','Accesos al portal de clientes'),
      ('inventory','Inventario','GestiÃ³n de inventario'),
      ('airway_bills','GuÃ­a AÃ©rea','GestiÃ³n de guÃ­as aÃ©reas'),
      ('manifests','Manifiestos','GestiÃ³n de manifiestos'),
      ('cuscar','CUSCAR SAT','Manifiestos CUSCAR SAT'),
      ('reports','Reportes','Reportes del sistema'),
      ('users','Usuarios','AdministraciÃ³n de usuarios'),
      ('settings','ConfiguraciÃ³n','ConfiguraciÃ³n general')`
    );

    db.run(
      `INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
      ('view','Ver','Acceso de lectura'),
      ('create','Crear','Crear registros'),
      ('edit','Editar','Editar registros'),
      ('delete','Eliminar','Eliminar registros'),
      ('export','Exportar','Exportar informaciÃ³n'),
      ('approve','Aprobar','Aprobar procesos'),
      ('manage','Administrar','Configuraciones'),
      ('assign_permissions','Asignar permisos','Gestionar permisos'),
      ('change_status','Cambiar estado','Cambio de estado'),
      ('close_manifest','Cerrar manifiesto','Cerrar manifiesto CUSCAR'),
      ('reopen_manifest','Reabrir manifiesto','Reabrir manifiesto CUSCAR'),
      ('preview_cuscar','Generar vista previa','Generar vista previa CUSCAR'),
      ('manage_catalogs','Administrar catÃ¡logos','AdministraciÃ³n de catÃ¡logos CUSCAR'),
      ('transmit_cuscar','Transmitir CUSCAR','Transmitir manifiesto CUSCAR'),
      ('void','Anular','Anular registros'),
      ('view_voided','Ver anulados','Ver registros anulados')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'packages' AND pa.code IN ('view','create','edit','delete','export','change_status')`
    );

      db.run(
        `INSERT OR IGNORE INTO module_actions (module_id, action_id)
         SELECT pm.id, pa.id
         FROM permission_modules pm, permission_actions pa
         WHERE pm.code = 'carrier_reception' AND pa.code IN ('view','create','edit','export')`
      );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'users' AND pa.code IN ('view','create','edit','delete','assign_permissions')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'billing' AND pa.code IN ('view','create','edit','export','approve')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'accounting' AND pa.code IN ('view','manage','create','export')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'agenda_medica' AND pa.code IN ('view','create','edit','delete')`
    );

    

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'inventory' AND pa.code IN ('view','create','edit','delete','export')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'manifests' AND pa.code IN ('view','create','edit','export')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'cuscar' AND pa.code IN ('view','create','edit','close_manifest','reopen_manifest','preview_cuscar','manage_catalogs','transmit_cuscar')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'airway_bills' AND pa.code IN ('view','create','edit','export')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'customers' AND pa.code IN ('view','create','edit','delete','void','view_voided')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'consignatarios' AND pa.code IN ('view','create','edit','delete','export')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'dashboard' AND pa.code IN ('view')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'portal' AND pa.code IN ('view','manage')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'reports' AND pa.code IN ('view','export')`
    );

    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'settings' AND pa.code IN ('view','manage')`
    );
  });
});

function getCompanyId(req) {
  const raw =
    req.session && (req.session.company_id || (req.session.company && req.session.company.id))
      ? req.session.company_id || (req.session.company && req.session.company.id)
      : null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function isAdminUser(req) {
  if (!req || !req.session) return false;
  if (req.session.permissionMap && req.session.permissionMap.isAdmin) return true;
  return req.session.user && req.session.user.role === 'admin';
}

function getClientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function signFileToken(relativePath, ttlMs) {
  if (!relativePath) return null;
  const expiresAt = Date.now() + (ttlMs || FILE_TOKEN_TTL_MS);
  const payload = JSON.stringify({ p: relativePath, e: expiresAt });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyFileToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payloadB64).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || !payload.p || !payload.e) return null;
  if (Date.now() > payload.e) return null;
  const rel = String(payload.p);
  if (rel.includes('..') || path.isAbsolute(rel)) return null;
  const filePath = path.resolve(path.join(UPLOAD_ROOT, rel));
  const root = path.resolve(UPLOAD_ROOT);
  if (!filePath.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

function signInvoiceUploadToken(packageId, companyId, ttlMs) {
  if (!Number.isInteger(packageId) || packageId <= 0) return null;
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  const expiresAt = Date.now() + (ttlMs || INVOICE_UPLOAD_TOKEN_TTL_MS);
  const payload = JSON.stringify({ pid: packageId, cid: companyId, e: expiresAt });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyInvoiceUploadToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payloadB64).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || !payload.pid || !payload.cid || !payload.e) return null;
  if (Date.now() > payload.e) return null;
  const packageId = Number(payload.pid);
  const companyId = Number(payload.cid);
  if (!Number.isInteger(packageId) || packageId <= 0) return null;
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  return { packageId, companyId };
}

function publicPathForFile(filePath) {
  if (!filePath) return null;
  const absPath = path.resolve(filePath);
  const uploadRoot = path.resolve(UPLOAD_ROOT);
  const relativeUpload = path.relative(uploadRoot, absPath);
  if (!relativeUpload.startsWith('..') && !path.isAbsolute(relativeUpload)) {
    return relativeUpload.replace(/\\/g, '/');
  }
  const publicRoot = path.resolve(path.join(__dirname, 'public'));
  const relativePublic = path.relative(publicRoot, absPath);
  if (!relativePublic.startsWith('..') && !path.isAbsolute(relativePublic)) {
    return `/${relativePublic.replace(/\\/g, '/')}`;
  }
  return null;
}

function buildFileUrl(storedPath) {
  if (!storedPath) return null;
  const raw = String(storedPath);
  if (/^https?:\/\//i.test(raw)) return raw;
  if (path.isAbsolute(raw)) {
    const absPath = path.resolve(raw);
    const uploadRoot = path.resolve(UPLOAD_ROOT);
    const relativeUpload = path.relative(uploadRoot, absPath);
    if (!relativeUpload.startsWith('..') && !path.isAbsolute(relativeUpload)) {
      const token = signFileToken(relativeUpload.replace(/\\/g, '/'), FILE_TOKEN_TTL_MS);
      return token ? `/files/${token}` : null;
    }
    const publicRoot = path.resolve(path.join(__dirname, 'public'));
    const relativePublic = path.relative(publicRoot, absPath);
    if (!relativePublic.startsWith('..') && !path.isAbsolute(relativePublic)) {
      return `/${relativePublic.replace(/\\/g, '/')}`;
    }
    return null;
  }
  if (raw.startsWith('/')) return raw;
  const cleaned = raw.replace(/^uploads[\\/]/, '').replace(/\\/g, '/');
  const token = signFileToken(cleaned, FILE_TOKEN_TTL_MS);
  return token ? `/files/${token}` : null;
}

function resolvePublicFilePath(publicUrl) {
  if (!publicUrl) return null;
  const trimmed = String(publicUrl).split('?')[0];
  if (/^https?:\/\//i.test(trimmed)) return null;
  const cleaned = trimmed.replace(/^\/+/, '').replace(/^public\//, '');
  const filePath = path.resolve(path.join(__dirname, 'public', cleaned));
  const publicRoot = path.resolve(path.join(__dirname, 'public'));
  if (!filePath.startsWith(publicRoot + path.sep)) return null;
  if (fs.existsSync(filePath)) return filePath;
  return null;
}

function formatBarcodeText(value) {
  if (!value) return '';
  return String(value).replace(/[^0-9A-Za-z:/?&=_\-.]/g, '');
}

function slugifyStatusKey(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const COMPANY_FONT_CHOICES = [
  { value: 'space-grotesk', label: 'Space Grotesk' },
  { value: 'manrope', label: 'Manrope' },
  { value: 'nunito', label: 'Nunito' },
  { value: 'source-serif', label: 'Source Serif' }
];
const DEFAULT_COMPANY_APPEARANCE = {
  primaryColor: '#d97757',
  secondaryColor: '#3d7b6f',
  backgroundColor: '#f8f5ee',
  titleColor: '#1c1b1a',
  textColor: '#1c1b1a',
  fontFamily: 'space-grotesk',
  logoSize: 34,
  iconSize: 62,
  iconFrame: false
};

function normalizeBooleanFlag(value, fallback = false) {
  const rawValue = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof rawValue === 'boolean') return rawValue;
  if (typeof rawValue === 'number') return rawValue !== 0;
  const normalized = normalizeString(rawValue).toLowerCase();
  if (['1', 'true', 'on', 'yes', 'si'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return Boolean(fallback);
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeCompanyFontFamily(value, fallback) {
  const normalized = normalizeString(value).toLowerCase();
  if (COMPANY_FONT_CHOICES.some((entry) => entry.value === normalized)) return normalized;
  return fallback || DEFAULT_COMPANY_APPEARANCE.fontFamily;
}

function normalizeThemeColor(value, fallback) {
  if (isHexColor(value)) return String(value).trim();
  return fallback;
}

function normalizeCompanyAppearanceSettings(raw, fallback = {}) {
  const safeFallback = {
    logoPath: fallback.logoPath || null,
    primaryColor: fallback.primaryColor || DEFAULT_COMPANY_APPEARANCE.primaryColor,
    secondaryColor: fallback.secondaryColor || DEFAULT_COMPANY_APPEARANCE.secondaryColor,
    backgroundColor: fallback.backgroundColor || DEFAULT_COMPANY_APPEARANCE.backgroundColor,
    titleColor: fallback.titleColor || DEFAULT_COMPANY_APPEARANCE.titleColor,
    textColor: fallback.textColor || DEFAULT_COMPANY_APPEARANCE.textColor,
    fontFamily: fallback.fontFamily || DEFAULT_COMPANY_APPEARANCE.fontFamily,
    logoSize: Number.isFinite(Number(fallback.logoSize)) ? Number(fallback.logoSize) : DEFAULT_COMPANY_APPEARANCE.logoSize,
    iconSize: Number.isFinite(Number(fallback.iconSize)) ? Number(fallback.iconSize) : DEFAULT_COMPANY_APPEARANCE.iconSize,
    iconFrame: typeof fallback.iconFrame === 'boolean' ? fallback.iconFrame : DEFAULT_COMPANY_APPEARANCE.iconFrame
  };

  return {
    logoPath: raw && Object.prototype.hasOwnProperty.call(raw, 'logoPath') ? raw.logoPath || null : safeFallback.logoPath,
    primaryColor: normalizeThemeColor(raw && raw.primaryColor, safeFallback.primaryColor),
    secondaryColor: normalizeThemeColor(raw && raw.secondaryColor, safeFallback.secondaryColor),
    backgroundColor: normalizeThemeColor(raw && raw.backgroundColor, safeFallback.backgroundColor),
    titleColor: normalizeThemeColor(raw && raw.titleColor, safeFallback.titleColor),
    textColor: normalizeThemeColor(raw && raw.textColor, safeFallback.textColor),
    fontFamily: normalizeCompanyFontFamily(raw && raw.fontFamily, safeFallback.fontFamily),
    logoSize: clampNumber(raw && raw.logoSize, 24, 84, safeFallback.logoSize),
    iconSize: clampNumber(raw && raw.iconSize, 44, 108, safeFallback.iconSize),
    iconFrame: normalizeBooleanFlag(raw && raw.iconFrame, safeFallback.iconFrame)
  };
}

function extractCompanyAppearance(company) {
  return normalizeCompanyAppearanceSettings({
    logoPath: company && company.logo ? company.logo : null,
    primaryColor: company && company.primary_color,
    secondaryColor: company && company.secondary_color,
    backgroundColor: company && company.theme_background_color,
    titleColor: company && company.theme_title_color,
    textColor: company && company.theme_text_color,
    fontFamily: company && company.theme_font_family,
    logoSize: company && company.theme_logo_size,
    iconSize: company && company.theme_icon_size,
    iconFrame: company && company.theme_icon_frame
  });
}

function buildCompanyThemeStyle(appearance) {
  const safeAppearance = normalizeCompanyAppearanceSettings(appearance || {});
  return [
    `--accent:${safeAppearance.primaryColor}`,
    `--accent-2:${safeAppearance.secondaryColor}`,
    `--bg:${safeAppearance.backgroundColor}`,
    `--ink:${safeAppearance.textColor}`,
    `--title-color:${safeAppearance.titleColor}`,
    `--brand-logo-size:${safeAppearance.logoSize}px`,
    `--launcher-icon-size:${safeAppearance.iconSize}px`,
    `--launcher-icon-frame:${safeAppearance.iconFrame ? 1 : 0}`
  ].join(';');
}

function saveCompanyAppearanceSettings(companyId, appearance, callback) {
  if (!companyId) return callback(new Error('missing company'));
  const safeAppearance = normalizeCompanyAppearanceSettings(appearance || {});
  db.run(
    `UPDATE companies
     SET logo = ?,
         primary_color = ?,
         secondary_color = ?,
         theme_background_color = ?,
         theme_title_color = ?,
         theme_text_color = ?,
         theme_font_family = ?,
         theme_logo_size = ?,
         theme_icon_size = ?,
         theme_icon_frame = ?
     WHERE id = ?`,
    [
      safeAppearance.logoPath || null,
      safeAppearance.primaryColor,
      safeAppearance.secondaryColor,
      safeAppearance.backgroundColor,
      safeAppearance.titleColor,
      safeAppearance.textColor,
      safeAppearance.fontFamily,
      safeAppearance.logoSize,
      safeAppearance.iconSize,
      safeAppearance.iconFrame ? 1 : 0,
      companyId
    ],
    (err) => callback(err)
  );
}

const DEFAULT_launcher_COLOR = '#1f2937';
const launcher_SETTINGS_KEY = 'launcher_settings';
const launcher_MODULE_CONFIG = {
  packages: {
    href: '/packages',
    color: '#d97757',
    icon: 'packages',
    nameKey: 'launcher.packages.name',
    descKey: 'launcher.packages.desc',
    order: 10
  },
  carrier_reception: {
    href: '/carrier-reception',
    color: '#0f766e',
    icon: 'reception',
    nameKey: 'launcher.reception.name',
    descKey: 'launcher.reception.desc',
    order: 15
  },
  customers: {
    href: '/customers',
    color: '#3d7b6f',
    icon: 'customers',
    nameKey: 'launcher.customers.name',
    descKey: 'launcher.customers.desc',
    order: 20
  },
  consignatarios: {
    href: '/consignatarios',
    color: '#6d28d9',
    icon: 'consignatarios',
    nameKey: 'launcher.consignatarios.name',
    descKey: 'launcher.consignatarios.desc',
    order: 25
  },
  inventory: {
    href: '/inventory',
    color: '#2f6f9e',
    icon: 'inventory',
    nameKey: 'launcher.inventory.name',
    descKey: 'launcher.inventory.desc',
    order: 30
  },
  users: {
    href: '/users',
    color: '#6b4f9a',
    icon: 'users',
    nameKey: 'launcher.users.name',
    descKey: 'launcher.users.desc',
    order: 40
  },
  billing: {
    href: '/invoices',
    color: '#b45309',
    icon: 'invoices',
    nameKey: 'launcher.invoices.name',
    descKey: 'launcher.invoices.desc',
    order: 50
  },
  accounting: {
    href: '/accounting/settings',
    color: '#0f4c5c',
    icon: 'accounting',
    nameKey: 'launcher.accounting.name',
    descKey: 'launcher.accounting.desc',
    order: 55
  },
  agenda_medica: {
    href: '/agenda-medica',
    color: '#0f766e',
    icon: 'agenda_medica',
    nameKey: 'launcher.agenda_medica.name',
    descKey: 'launcher.agenda_medica.desc',
    order: 58
  },
  rrhh: {
    href: '/rrhh',
    color: '#155e75',
    icon: 'rrhh',
    order: 59
  },
  portal: {
    href: '/customer/login',
    color: '#2563eb',
    icon: 'portal',
    nameKey: 'launcher.portal.name',
    descKey: 'launcher.portal.desc',
    order: 60
  },
  manifests: {
    href: '/manifests',
    color: '#0f766e',
    icon: 'manifest',
    nameKey: 'launcher.manifests.name',
    descKey: 'launcher.manifests.desc',
    order: 64
  },
  cuscar: {
    href: '/cuscar',
    color: '#0a4a6d',
    icon: 'cuscar',
    nameKey: 'launcher.cuscar.name',
    descKey: 'launcher.cuscar.desc',
    order: 65
  },
  airway_bills: {
    href: '/airway-bills',
    color: '#9d3f35',
    icon: 'awb',
    nameKey: 'launcher.awb.name',
    descKey: 'launcher.awb.desc',
    order: 66
  },
  reports: {
    href: '/packages/reports',
    color: '#7c3aed',
    icon: 'reports',
    order: 70
  },
  settings: {
    href: '/settings',
    color: '#111827',
    icon: 'settings',
    nameKey: 'launcher.settings_module.name',
    descKey: 'launcher.settings_module.desc',
    order: 80
  }
};

const launcher_ICON_MAP = {
  packages: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M3 7.5l9 4.5 9-4.5-9-4.5-9 4.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M3 7.5v9l9 4.5 9-4.5v-9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M12 12v9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  reception: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M4 7h16v10H4z" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M7 7v-2h10v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M8 12h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M10 15h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  customers: `<svg viewBox="0 0 24 24" aria-hidden="true">
<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M4 18.2c0-3 2.5-5.4 5.6-5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<circle cx="17" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M14.4 18.2c0-2.3 1.9-4.1 4.1-4.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  consignatarios: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M7 6.5h10a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 15v-6A2.5 2.5 0 0 1 7 6.5z" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M9 9.5h6M9 12.5h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M6 5l2-2m8 2-2-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  inventory: `<svg viewBox="0 0 24 24" aria-hidden="true">
<rect x="3" y="4" width="7" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
<rect x="14" y="4" width="7" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
<rect x="3" y="13" width="7" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
<rect x="14" y="13" width="7" height="7" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
</svg>`,
  users: `<svg viewBox="0 0 24 24" aria-hidden="true">
<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>
<circle cx="16" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M3.5 18c0-2.6 2.3-4.7 5.1-4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M15.4 13.3c2.8 0 5.1 2.1 5.1 4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  invoices: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M6 3h9l3 3v15l-3-2-3 2-3-2-3 2V3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M8 9h8M8 13h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  accounting: `<svg viewBox="0 0 24 24" aria-hidden="true">
<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M7 8h10M7 12h10M7 16h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  agenda_medica: `<svg viewBox="0 0 24 24" aria-hidden="true">
<rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M7 11h10M7 15h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  rrhh: `<svg viewBox="0 0 24 24" aria-hidden="true">
<circle cx="9" cy="8" r="2.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M4.5 18c0-2.9 2-5 4.8-5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<circle cx="16.5" cy="8.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M13.7 17.8c.2-2.2 1.8-4 4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M12 5v14M9.5 12h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  manifest: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M8 12h8M8 16h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  cuscar: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M4 5h10l6 6-6 6H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M7 9h5M7 12h8M7 15h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  awb: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M4 6h10l6 6-6 6H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M7 9h6M7 12h4M7 15h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  tracking: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 21s6-5.4 6-10.3A6 6 0 0 0 6 10.7C6 15.6 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.8"/>
<circle cx="12" cy="10.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>
</svg>`,
  portal: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M4 4h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H4z" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M9 12h11m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  master: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M3 7l4 4 5-6 5 6 4-4v10H3V7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M7 17v3h10v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  settings: `<svg viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M19 12a7 7 0 0 0-.1-1.1l2-1.5-2-3.4-2.4.8a7.2 7.2 0 0 0-1.9-1.1L12.8 3H11l-.8 2.7a7.2 7.2 0 0 0-1.9 1.1l-2.4-.8-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .7.1 1.1l-2 1.5 2 3.4 2.4-.8c.6.5 1.2.8 1.9 1.1l.8 2.7h1.8l.8-2.7c.7-.2 1.3-.6 1.9-1.1l2.4.8 2-3.4-2-1.5c.1-.4.1-.7.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
  reports: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
<path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M9 13h6M9 17h6M9 9h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`,
  default: `<svg viewBox="0 0 24 24" aria-hidden="true">
<rect x="4" y="5" width="16" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M8 10h8M8 14h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`
};
  const EXTRA_launcher_MODULES = [
  {
    key: 'tracking',
    href: '/tracking',
    color: '#0f766e',
    icon: 'tracking',
    nameKey: 'launcher.tracking.name',
    descKey: 'launcher.tracking.desc',
    order: 65,
    alwaysShow: true
  },
  {
    key: 'master',
    href: '/master',
    color: '#1f2937',
    icon: 'master',
    nameKey: 'launcher.master.name',
    descKey: 'launcher.master.desc',
    order: 90,
    requiresMaster: true
  }
];

function buildPackageStatuslauncherModules(t) {
  return PACKAGE_STATUSES.map((status, index) => ({
    key: `packages_status_${slugifyStatusKey(status)}`,
    name: status,
    desc: t('launcher.packages_status.desc', { status }),
    href: `/packages/status-by-manifest?status=${encodeURIComponent(status)}`,
    color: PACKAGE_STATUS_launcher_COLORS[status] || DEFAULT_launcher_COLOR,
    icon: 'packages',
    order: 12 + index
  }));
}

function buildlauncherModules(dbConn, t, permissionMap, isMaster, callback) {
  const hasAnyPermission = (code) => {
    if (!permissionMap) return false;
    if (!isModuleAllowed(permissionMap, code)) return false;
    if (permissionMap.isAdmin) return true;
    const modulePerms = permissionMap.modules && permissionMap.modules[code];
    if (!modulePerms) return false;
    return Object.keys(modulePerms).length > 0;
  };

  dbConn.all(
    'SELECT code, name, description FROM permission_modules WHERE is_active = 1 ORDER BY name',
    [],
    (err, rows) => {
      const modules = [];
      const seen = new Set();
      const safeRows = err || !rows ? [] : rows;

      safeRows.forEach((row) => {
        const code = row.code;
        const config = launcher_MODULE_CONFIG[code] || {};
        const shouldShow = config.alwaysShow || hasAnyPermission(code);
        if (!shouldShow) return;
        const href = config.href || `/${String(code).replace(/_/g, '-')}`;
        modules.push({
          key: code,
          name: config.nameKey ? t(config.nameKey) : row.name || code,
          desc: config.descKey ? t(config.descKey) : row.description || '',
          href,
          color: config.color || DEFAULT_launcher_COLOR,
          icon: config.icon || 'default',
          order: config.order || 999
        });
        seen.add(code);
      });

        EXTRA_launcher_MODULES.forEach((extra) => {
          if (seen.has(extra.key)) return;
          if (extra.requiresMaster && !isMaster) return;
          if (!extra.alwaysShow && !hasAnyPermission(extra.key)) return;
          modules.push({
          key: extra.key,
          name: extra.nameKey ? t(extra.nameKey) : extra.key,
          desc: extra.descKey ? t(extra.descKey) : '',
          href: extra.href,
          color: extra.color || DEFAULT_launcher_COLOR,
          icon: extra.icon || extra.key,
          order: extra.order || 999,
            alwaysVisible: Boolean(extra.alwaysVisible)
          });
        });

        Object.keys(launcher_MODULE_CONFIG).forEach((code) => {
          if (seen.has(code)) return;
          const config = launcher_MODULE_CONFIG[code] || {};
          const shouldShow = config.alwaysShow || hasAnyPermission(code);
          if (!shouldShow) return;
          const href = config.href || `/${String(code).replace(/_/g, '-')}`;
          modules.push({
            key: code,
            name: config.nameKey ? t(config.nameKey) : code,
            desc: config.descKey ? t(config.descKey) : '',
            href,
            color: config.color || DEFAULT_launcher_COLOR,
            icon: config.icon || 'default',
            order: config.order || 999
          });
          seen.add(code);
        });

      if (hasAnyPermission('packages')) {
        buildPackageStatuslauncherModules(t).forEach((statusModule) => {
          if (seen.has(statusModule.key)) return;
          modules.push(statusModule);
          seen.add(statusModule.key);
        });
      }

        modules.sort((a, b) => {
          if (a.key === launcher_SETTINGS_KEY && b.key !== launcher_SETTINGS_KEY) return 1;
          if (b.key === launcher_SETTINGS_KEY && a.key !== launcher_SETTINGS_KEY) return -1;
          if (a.order !== b.order) return a.order - b.order;
          return String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' });
        });

      callback(modules);
    }
  );
}

function parselauncherModuleList(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((entry) => String(entry));
  } catch (err) {
    return null;
  }
}

const launcher_WIDGET_KEYS = ['hero', 'notes', 'planner', 'apps'];

function normalizeLauncherWidgetPrefs(raw) {
  const prefs = {
    order: [...launcher_WIDGET_KEYS],
    visibility: { hero: true, notes: true, planner: true, apps: true },
    notesCollapsed: false,
    notesLayout: 'vertical',
    plannerHidePast: false,
    plannerHideBefore: null,
    plannerFocusDate: null,
    plannerColor: null,
    plannerShowHistory: false,
    plannerHistoryMode: 'month',
    plannerHistoryCursor: null
  };
  if (!raw || typeof raw !== 'object') return prefs;
  if (Array.isArray(raw.order)) {
    const unique = [];
    raw.order.forEach((key) => {
      if (!launcher_WIDGET_KEYS.includes(key)) return;
      if (unique.includes(key)) return;
      unique.push(key);
    });
    launcher_WIDGET_KEYS.forEach((key) => {
      if (!unique.includes(key)) unique.push(key);
    });
    prefs.order = unique;
  }
  if (raw.visibility && typeof raw.visibility === 'object') {
    launcher_WIDGET_KEYS.forEach((key) => {
      if (typeof raw.visibility[key] === 'boolean') prefs.visibility[key] = raw.visibility[key];
    });
  }
  if (typeof raw.notesCollapsed === 'boolean') prefs.notesCollapsed = raw.notesCollapsed;
  if (raw.notesLayout === 'grid' || raw.notesLayout === 'vertical') prefs.notesLayout = raw.notesLayout;
  if (typeof raw.plannerHidePast === 'boolean') prefs.plannerHidePast = raw.plannerHidePast;
  if (isIsoDate(raw.plannerHideBefore)) prefs.plannerHideBefore = raw.plannerHideBefore;
  if (isIsoDate(raw.plannerFocusDate)) prefs.plannerFocusDate = raw.plannerFocusDate;
  if (isHexColor(raw.plannerColor)) prefs.plannerColor = raw.plannerColor.trim();
  if (typeof raw.plannerShowHistory === 'boolean') prefs.plannerShowHistory = raw.plannerShowHistory;
  if (raw.plannerHistoryMode === 'week' || raw.plannerHistoryMode === 'month' || raw.plannerHistoryMode === 'year') {
    prefs.plannerHistoryMode = raw.plannerHistoryMode;
  }
  if (isIsoDate(raw.plannerHistoryCursor)) prefs.plannerHistoryCursor = raw.plannerHistoryCursor;
  return prefs;
}

function parseLauncherWidgetPrefs(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeLauncherWidgetPrefs(parsed);
  } catch (err) {
    return null;
  }
}

function normalizeLauncherLayoutPrefs(raw, options = {}) {
  const allowedSet = options.allowedSet instanceof Set ? options.allowedSet : null;
  const visibleSet = options.visibleSet instanceof Set ? options.visibleSet : null;
  const normalized = {
    groups: [],
    assignments: {}
  };

  if (!raw || typeof raw !== 'object') return normalized;

  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const seenGroups = new Set();
  groups.slice(0, 8).forEach((group, index) => {
    const rawId = normalizeString(group && group.id);
    const id = rawId || `group_${index + 1}`;
    if (seenGroups.has(id)) return;
    const name = normalizeString(group && group.name).slice(0, 32) || `Grupo ${normalized.groups.length + 1}`;
    normalized.groups.push({ id, name });
    seenGroups.add(id);
  });

  const assignments = raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
  const assignedModules = new Set();
  Object.entries(assignments).forEach(([moduleKey, groupId]) => {
    const safeModuleKey = String(moduleKey);
    const safeGroupId = normalizeString(groupId);
    if (!safeGroupId || !seenGroups.has(safeGroupId)) return;
    if (allowedSet && !allowedSet.has(safeModuleKey)) return;
    if (visibleSet && !visibleSet.has(safeModuleKey)) return;
    if (assignedModules.has(safeModuleKey)) return;
    normalized.assignments[safeModuleKey] = safeGroupId;
    assignedModules.add(safeModuleKey);
  });

  return normalized;
}

function parseLauncherLayoutPrefs(raw, options = {}) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeLauncherLayoutPrefs(parsed, options);
  } catch (err) {
    return null;
  }
}

function buildLauncherIconLayout(modules, layoutPrefs) {
  const safeModules = Array.isArray(modules) ? modules : [];
  const allowedSet = new Set(safeModules.map((mod) => mod.key));
  const normalizedLayout = normalizeLauncherLayoutPrefs(layoutPrefs, { allowedSet });
  const groupMap = new Map(normalizedLayout.groups.map((group) => [group.id, { ...group, modules: [] }]));
  const layoutItems = [];
  const renderedGroups = new Set();

  safeModules.forEach((mod) => {
    const groupId = normalizedLayout.assignments[mod.key];
    const group = groupId ? groupMap.get(groupId) : null;
    if (!group) {
      layoutItems.push({ type: 'module', key: mod.key, module: mod });
      return;
    }
    group.modules.push(mod);
    if (renderedGroups.has(group.id)) return;
    layoutItems.push({ type: 'group', key: group.id, group });
    renderedGroups.add(group.id);
  });

  return {
    items: layoutItems.filter((entry) => entry.type === 'module' || (entry.group && entry.group.modules.length)),
    groups: normalizedLayout.groups,
    assignments: normalizedLayout.assignments
  };
}

function getlauncherPreferences(userId, companyId, callback) {
  if (!userId || !companyId) return callback(null);
  db.get(
    'SELECT visible_modules, widget_prefs, layout_prefs FROM launcher_preferences WHERE user_id = ? AND company_id = ? LIMIT 1',
    [userId, companyId],
    (err, row) => {
      if (err || !row) return callback(null);
      const visibleModules = parselauncherModuleList(row.visible_modules);
      const widgetPrefs = parseLauncherWidgetPrefs(row.widget_prefs);
      const layoutPrefs = parseLauncherLayoutPrefs(row.layout_prefs);
      if (!visibleModules && !widgetPrefs && !layoutPrefs) return callback(null);
      return callback({
        visibleModules: visibleModules || null,
        widgetPrefs: widgetPrefs || null,
        layoutPrefs: layoutPrefs || null
      });
    }
  );
}

function savelauncherPreferences(userId, companyId, visibleModules, layoutPrefs, callback) {
  let finalLayoutPrefs = layoutPrefs;
  let finalCallback = callback;
  if (typeof finalLayoutPrefs === 'function') {
    finalCallback = finalLayoutPrefs;
    finalLayoutPrefs = undefined;
  }
  if (!userId || !companyId) {
    if (finalCallback) finalCallback(new Error('Missing user or company'));
    return;
  }
  const payload = JSON.stringify(Array.isArray(visibleModules) ? visibleModules : []);
  const layoutPayload = typeof finalLayoutPrefs === 'undefined' ? undefined : JSON.stringify(finalLayoutPrefs || { groups: [], assignments: {} });
  db.get(
    'SELECT id FROM launcher_preferences WHERE user_id = ? AND company_id = ? LIMIT 1',
    [userId, companyId],
    (err, row) => {
      if (err) {
        if (finalCallback) finalCallback(err);
        return;
      }
      if (row && row.id) {
        const sql = typeof layoutPayload === 'undefined'
          ? 'UPDATE launcher_preferences SET visible_modules = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          : 'UPDATE launcher_preferences SET visible_modules = ?, layout_prefs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
        const params = typeof layoutPayload === 'undefined' ? [payload, row.id] : [payload, layoutPayload, row.id];
        db.run(sql, params, (updateErr) => finalCallback && finalCallback(updateErr));
        return;
      }
      const sql = typeof layoutPayload === 'undefined'
        ? 'INSERT INTO launcher_preferences (user_id, company_id, visible_modules) VALUES (?, ?, ?)'
        : 'INSERT INTO launcher_preferences (user_id, company_id, visible_modules, layout_prefs) VALUES (?, ?, ?, ?)';
      const params = typeof layoutPayload === 'undefined'
        ? [userId, companyId, payload]
        : [userId, companyId, payload, layoutPayload];
      db.run(sql, params, (insertErr) => finalCallback && finalCallback(insertErr));
    }
  );
}

function savelauncherWidgetPrefs(userId, companyId, widgetPrefs, callback) {
  if (!userId || !companyId) {
    if (callback) callback(new Error('Missing user or company'));
    return;
  }
  const payload = JSON.stringify(normalizeLauncherWidgetPrefs(widgetPrefs));
  db.get(
    'SELECT id FROM launcher_preferences WHERE user_id = ? AND company_id = ? LIMIT 1',
    [userId, companyId],
    (err, row) => {
      if (err) {
        if (callback) callback(err);
        return;
      }
      if (row && row.id) {
        db.run(
          'UPDATE launcher_preferences SET widget_prefs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [payload, row.id],
          (updateErr) => callback && callback(updateErr)
        );
        return;
      }
      db.run(
        'INSERT INTO launcher_preferences (user_id, company_id, widget_prefs) VALUES (?, ?, ?)',
        [userId, companyId, payload],
        (insertErr) => callback && callback(insertErr)
      );
    }
  );
}

function applylauncherPreferences(modules, prefs) {
  const visibleList = prefs && Array.isArray(prefs.visibleModules) ? prefs.visibleModules : null;
  if (!visibleList) return modules;
  const visibleSet = new Set(visibleList);
  const orderedModules = (modules || []).filter((mod) => mod && (mod.alwaysVisible || visibleSet.has(mod.key)));
  const configurable = orderedModules.filter((mod) => !mod.alwaysVisible);
  const configurableMap = new Map(configurable.map((mod) => [mod.key, mod]));
  const orderedConfigurable = [];

  visibleList.forEach((key) => {
    const mod = configurableMap.get(key);
    if (!mod) return;
    orderedConfigurable.push(mod);
    configurableMap.delete(key);
  });

  configurable.forEach((mod) => {
    if (!configurableMap.has(mod.key)) return;
    orderedConfigurable.push(mod);
    configurableMap.delete(mod.key);
  });

  let configurableIndex = 0;
  return orderedModules.map((mod) => {
    if (mod.alwaysVisible) return mod;
    const nextMod = orderedConfigurable[configurableIndex];
    configurableIndex += 1;
    return nextMod || mod;
  });
}

const WORKSPACE_DOCK_POSITIONS = ['left', 'right', 'top', 'bottom', 'center-top', 'center-bottom'];
const WORKSPACE_DOCK_MODES = ['fixed', 'auto-hide', 'expandable'];
const WORKSPACE_ICON_STYLES = ['soft', 'solid', 'outline'];
const WORKSPACE_LAYOUT_MODES = ['light', 'dark'];
const WORKSPACE_DOCK_PRIORITY_KEYS = ['notes', 'planner'];
const DEFAULT_WORKSPACE_SETTINGS = {
  dockEnabled: true,
  dockPosition: 'left',
  dockMode: 'auto-hide',
  dockAutoHide: true,
  showLabels: true,
  themeColor: '#1f3b63',
  accentColor: '#2563eb',
  backgroundColor: '#eef3fb',
  dockColor: '#0f172a',
  iconStyle: 'soft',
  iconSize: 92,
  useGlassEffect: true,
  layoutMode: 'light'
};
const WORKSPACE_MAX_FOLDERS = 24;
const WORKSPACE_MAX_MODULES = 96;
const WORKSPACE_DOCK_DEFAULT_COUNT = 5;
const WORKSPACE_DESKTOP_START_X = 72;
const WORKSPACE_DESKTOP_START_Y = 72;
const WORKSPACE_DESKTOP_STEP_X = 152;
const WORKSPACE_DESKTOP_STEP_Y = 152;
const WORKSPACE_FOLDER_ICON = 'inventory';

function normalizeWorkspaceDockPosition(value, fallback = DEFAULT_WORKSPACE_SETTINGS.dockPosition) {
  const normalized = normalizeString(value).toLowerCase();
  if (WORKSPACE_DOCK_POSITIONS.includes(normalized)) return normalized;
  return fallback;
}

function normalizeWorkspaceDockMode(value, fallback = DEFAULT_WORKSPACE_SETTINGS.dockMode) {
  const normalized = normalizeString(value).toLowerCase();
  if (WORKSPACE_DOCK_MODES.includes(normalized)) return normalized;
  return fallback;
}

function normalizeWorkspaceIconStyle(value, fallback = DEFAULT_WORKSPACE_SETTINGS.iconStyle) {
  const normalized = normalizeString(value).toLowerCase();
  if (WORKSPACE_ICON_STYLES.includes(normalized)) return normalized;
  return fallback;
}

function normalizeWorkspaceLayoutMode(value, fallback = DEFAULT_WORKSPACE_SETTINGS.layoutMode) {
  const normalized = normalizeString(value).toLowerCase();
  if (WORKSPACE_LAYOUT_MODES.includes(normalized)) return normalized;
  return fallback;
}

function normalizeWorkspaceIconName(value, fallback = 'default') {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized && Object.prototype.hasOwnProperty.call(launcher_ICON_MAP, normalized)) return normalized;
  return fallback;
}

function buildWorkspaceSettingsFallback(companyBrand) {
  const safeBrand = companyBrand || {};
  return normalizeWorkspaceSettings({
    dockEnabled: DEFAULT_WORKSPACE_SETTINGS.dockEnabled,
    dockPosition: DEFAULT_WORKSPACE_SETTINGS.dockPosition,
    dockMode: DEFAULT_WORKSPACE_SETTINGS.dockMode,
    dockAutoHide: DEFAULT_WORKSPACE_SETTINGS.dockAutoHide,
    showLabels: DEFAULT_WORKSPACE_SETTINGS.showLabels,
    themeColor: safeBrand.primary_color || DEFAULT_WORKSPACE_SETTINGS.themeColor,
    accentColor: safeBrand.secondary_color || DEFAULT_WORKSPACE_SETTINGS.accentColor,
    backgroundColor: safeBrand.background_color || DEFAULT_WORKSPACE_SETTINGS.backgroundColor,
    dockColor: safeBrand.title_color || safeBrand.text_color || DEFAULT_WORKSPACE_SETTINGS.dockColor,
    iconStyle: DEFAULT_WORKSPACE_SETTINGS.iconStyle,
    iconSize: Number.isFinite(Number(safeBrand.icon_size)) ? Number(safeBrand.icon_size) + 18 : DEFAULT_WORKSPACE_SETTINGS.iconSize,
    useGlassEffect: true,
    layoutMode: DEFAULT_WORKSPACE_SETTINGS.layoutMode
  });
}

function parseWorkspaceDockModules(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => normalizeString(entry))
      .filter(Boolean);
  }
  const text = normalizeString(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((entry) => normalizeString(entry))
      .filter(Boolean);
  } catch (err) {
    return null;
  }
}

function normalizeWorkspaceDockModulesList(list, allowedSet) {
  const unique = [];
  const safeList = Array.isArray(list) ? list : [];
  safeList.forEach((entry) => {
    const key = normalizeString(entry);
    if (!key) return;
    if (allowedSet instanceof Set && !allowedSet.has(key)) return;
    if (unique.includes(key)) return;
    unique.push(key);
  });
  return unique;
}

function buildDefaultWorkspaceDockModules(modules) {
  const safeModules = Array.isArray(modules) ? modules : [];
  const allowedKeys = safeModules
    .map((module) => normalizeString(module && (module.key || module.moduleKey)))
    .filter(Boolean);
  const defaults = [];
  const allowedSet = new Set(allowedKeys);

  WORKSPACE_DOCK_PRIORITY_KEYS.forEach((key) => {
    if (!allowedSet.has(key) || defaults.includes(key)) return;
    defaults.push(key);
  });

  allowedKeys.forEach((key) => {
    if (defaults.length >= WORKSPACE_DOCK_DEFAULT_COUNT) return;
    if (defaults.includes(key)) return;
    defaults.push(key);
  });

  return defaults;
}

function resolveWorkspaceDockModules(rawValue, modules, fallbackValue = undefined) {
  const safeModules = Array.isArray(modules) ? modules : [];
  const allowedKeys = safeModules
    .map((module) => normalizeString(module && (module.key || module.moduleKey)))
    .filter(Boolean);
  if (!allowedKeys.length) return [];

  const allowedSet = new Set(allowedKeys);
  const resolvedValue = parseWorkspaceDockModules(rawValue);
  if (resolvedValue !== null) {
    return normalizeWorkspaceDockModulesList(resolvedValue, allowedSet);
  }

  if (typeof fallbackValue !== 'undefined') {
    const resolvedFallback = parseWorkspaceDockModules(fallbackValue);
    if (resolvedFallback !== null) {
      return normalizeWorkspaceDockModulesList(resolvedFallback, allowedSet);
    }
  }

  return buildDefaultWorkspaceDockModules(safeModules);
}

function normalizeWorkspaceSettings(raw, fallback = {}) {
  const fallbackDockModules = parseWorkspaceDockModules(
    Object.prototype.hasOwnProperty.call(fallback, 'dockModules') ? fallback.dockModules : fallback.dock_modules
  );
  const rawDockModules = parseWorkspaceDockModules(
    raw && (Object.prototype.hasOwnProperty.call(raw, 'dockModules') ? raw.dockModules : raw.dock_modules)
  );
  const safeFallback = {
    dockEnabled: normalizeBooleanFlag(
      Object.prototype.hasOwnProperty.call(fallback, 'dockEnabled') ? fallback.dockEnabled : fallback.dock_enabled,
      DEFAULT_WORKSPACE_SETTINGS.dockEnabled
    ),
    dockPosition: normalizeWorkspaceDockPosition(fallback.dockPosition || fallback.dock_position || DEFAULT_WORKSPACE_SETTINGS.dockPosition),
    dockMode: normalizeWorkspaceDockMode(fallback.dockMode || fallback.dock_mode || DEFAULT_WORKSPACE_SETTINGS.dockMode),
    dockAutoHide: normalizeBooleanFlag(
      Object.prototype.hasOwnProperty.call(fallback, 'dockAutoHide') ? fallback.dockAutoHide : fallback.dock_auto_hide,
      DEFAULT_WORKSPACE_SETTINGS.dockAutoHide
    ),
    showLabels: normalizeBooleanFlag(
      Object.prototype.hasOwnProperty.call(fallback, 'showLabels') ? fallback.showLabels : fallback.show_labels,
      DEFAULT_WORKSPACE_SETTINGS.showLabels
    ),
    themeColor: normalizeThemeColor(fallback.themeColor || fallback.theme_color, DEFAULT_WORKSPACE_SETTINGS.themeColor),
    accentColor: normalizeThemeColor(fallback.accentColor || fallback.accent_color, DEFAULT_WORKSPACE_SETTINGS.accentColor),
    backgroundColor: normalizeThemeColor(fallback.backgroundColor || fallback.background_color, DEFAULT_WORKSPACE_SETTINGS.backgroundColor),
    dockColor: normalizeThemeColor(fallback.dockColor || fallback.dock_color, DEFAULT_WORKSPACE_SETTINGS.dockColor),
    dockModules: fallbackDockModules,
    iconStyle: normalizeWorkspaceIconStyle(fallback.iconStyle || fallback.icon_style || DEFAULT_WORKSPACE_SETTINGS.iconStyle),
    iconSize: clampNumber(fallback.iconSize || fallback.icon_size || fallback.dockSize || fallback.dock_size, 72, 132, DEFAULT_WORKSPACE_SETTINGS.iconSize),
    useGlassEffect: normalizeBooleanFlag(
      Object.prototype.hasOwnProperty.call(fallback, 'useGlassEffect') ? fallback.useGlassEffect : fallback.use_glass_effect,
      DEFAULT_WORKSPACE_SETTINGS.useGlassEffect
    ),
    layoutMode: normalizeWorkspaceLayoutMode(fallback.layoutMode || fallback.layout_mode, DEFAULT_WORKSPACE_SETTINGS.layoutMode)
  };

  return {
    dockEnabled: normalizeBooleanFlag(
      raw && (Object.prototype.hasOwnProperty.call(raw, 'dockEnabled') ? raw.dockEnabled : raw.dock_enabled),
      safeFallback.dockEnabled
    ),
    dockPosition: normalizeWorkspaceDockPosition(raw && (raw.dockPosition || raw.dock_position), safeFallback.dockPosition),
    dockMode: normalizeWorkspaceDockMode(raw && (raw.dockMode || raw.dock_mode), safeFallback.dockMode),
    dockAutoHide: normalizeBooleanFlag(
      raw && (Object.prototype.hasOwnProperty.call(raw, 'dockAutoHide') ? raw.dockAutoHide : raw.dock_auto_hide),
      safeFallback.dockAutoHide
    ),
    showLabels: normalizeBooleanFlag(
      raw && (Object.prototype.hasOwnProperty.call(raw, 'showLabels') ? raw.showLabels : raw.show_labels),
      safeFallback.showLabels
    ),
    themeColor: normalizeThemeColor(raw && (raw.themeColor || raw.theme_color), safeFallback.themeColor),
    accentColor: normalizeThemeColor(raw && (raw.accentColor || raw.accent_color), safeFallback.accentColor),
    backgroundColor: normalizeThemeColor(raw && (raw.backgroundColor || raw.background_color), safeFallback.backgroundColor),
    dockColor: normalizeThemeColor(raw && (raw.dockColor || raw.dock_color), safeFallback.dockColor),
    dockModules: rawDockModules === null ? safeFallback.dockModules : rawDockModules,
    iconStyle: normalizeWorkspaceIconStyle(raw && (raw.iconStyle || raw.icon_style), safeFallback.iconStyle),
    iconSize: clampNumber(raw && (raw.iconSize || raw.icon_size || raw.dockSize || raw.dock_size), 72, 132, safeFallback.iconSize),
    useGlassEffect: normalizeBooleanFlag(
      raw && (Object.prototype.hasOwnProperty.call(raw, 'useGlassEffect') ? raw.useGlassEffect : raw.use_glass_effect),
      safeFallback.useGlassEffect
    ),
    layoutMode: normalizeWorkspaceLayoutMode(raw && (raw.layoutMode || raw.layout_mode), safeFallback.layoutMode),
    dockSize: clampNumber(raw && (raw.dockSize || raw.dock_size || raw.iconSize || raw.icon_size), 72, 132, safeFallback.iconSize)
  };
}

function clampWorkspaceCoordinate(value, fallback) {
  return clampNumber(value, 0, 5000, fallback);
}

function normalizeWorkspaceLocation(value, fallback = 'desktop') {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'dock' || normalized === 'desktop' || normalized === 'folder') return normalized;
  return fallback;
}

function buildWorkspaceGridPosition(index, options = {}) {
  const startX = Number.isFinite(Number(options.startX)) ? Number(options.startX) : WORKSPACE_DESKTOP_START_X;
  const startY = Number.isFinite(Number(options.startY)) ? Number(options.startY) : WORKSPACE_DESKTOP_START_Y;
  const columns = Number.isFinite(Number(options.columns)) ? Number(options.columns) : 4;
  const safeIndex = Math.max(0, Number(index) || 0);
  return {
    posX: startX + (safeIndex % columns) * WORKSPACE_DESKTOP_STEP_X,
    posY: startY + Math.floor(safeIndex / columns) * WORKSPACE_DESKTOP_STEP_Y
  };
}

function getWorkspaceModuleGroup(moduleKey) {
  const key = normalizeString(moduleKey);
  if (key.startsWith('packages_status_') || ['packages', 'carrier_reception', 'manifests', 'cuscar', 'airway_bills'].includes(key)) {
    return 'operations';
  }
  if (['customers', 'consignatarios', 'portal', 'tracking'].includes(key)) {
    return 'people';
  }
  if (['inventory', 'billing', 'accounting', 'reports'].includes(key)) {
    return 'business';
  }
  if (['users', 'settings', 'rrhh', 'agenda_medica'].includes(key)) {
    return 'admin';
  }
  return 'general';
}

function buildDefaultWorkspaceLayout(modules) {
  const safeModules = Array.isArray(modules) ? modules : [];
  return {
    folders: [],
    modules: safeModules.slice(0, WORKSPACE_MAX_MODULES).map((module, index) => {
      const desktopPosition = buildWorkspaceGridPosition(index);
      return {
        moduleKey: module.key,
        name: module.name,
        desc: module.desc,
        href: module.href,
        iconName: normalizeWorkspaceIconName(module.icon, 'default'),
        color: module.color || DEFAULT_launcher_COLOR,
        group: module.group || getWorkspaceModuleGroup(module.key),
        location: 'desktop',
        folderId: null,
        posX: desktopPosition.posX,
        posY: desktopPosition.posY,
        sortOrder: index,
        isVisible: true
      };
    })
  };
}

function getUserWorkspaceSettings(userId, companyId, callback) {
  if (!userId || !companyId) return callback(null);
  db.get(
    `SELECT dock_enabled, dock_position, dock_mode, dock_auto_hide, dock_size, show_labels,
            theme_color, accent_color, background_color, dock_color, dock_modules,
            icon_style, icon_size, use_glass_effect, layout_mode
     FROM user_workspace_settings
     WHERE user_id = ? AND company_id = ?
     LIMIT 1`,
    [userId, companyId],
    (err, row) => callback(err || !row ? null : normalizeWorkspaceSettings(row))
  );
}

function getUserWorkspaceItems(userId, companyId, callback) {
  if (!userId || !companyId) return callback([]);
  db.all(
    `SELECT id, item_type, module_key, folder_name, icon_name, color, pos_x, pos_y,
            sort_order, parent_folder_id, is_visible
     FROM user_workspace_items
     WHERE user_id = ? AND company_id = ?
     ORDER BY CASE WHEN item_type = 'folder' THEN 0 ELSE 1 END, sort_order ASC, id ASC`,
    [userId, companyId],
    (err, rows) => callback(err || !rows ? [] : rows)
  );
}

function buildWorkspaceState(modules, companyBrand, savedSettings, itemRows) {
  const safeModules = Array.isArray(modules) ? modules.slice(0, WORKSPACE_MAX_MODULES) : [];
  const fallbackSettings = buildWorkspaceSettingsFallback(companyBrand);
  const settings = normalizeWorkspaceSettings(savedSettings || {}, fallbackSettings);
  settings.dockModules = resolveWorkspaceDockModules(settings.dockModules, safeModules, fallbackSettings.dockModules);
  const defaultLayout = buildDefaultWorkspaceLayout(safeModules);
  const defaultModuleMap = new Map(defaultLayout.modules.map((entry) => [entry.moduleKey, entry]));
  const rows = Array.isArray(itemRows) ? itemRows : [];
  const folderRows = rows.filter((row) => normalizeString(row.item_type).toLowerCase() === 'folder').slice(0, WORKSPACE_MAX_FOLDERS);
  const folderIdMap = new Map();
  const folders = folderRows.map((row, index) => {
    const defaults = buildWorkspaceGridPosition(index, { startX: 96, startY: 96 });
    const folder = {
      id: `folder:${row.id}`,
      name: normalizeString(row.folder_name).slice(0, 42) || `Carpeta ${index + 1}`,
      color: normalizeThemeColor(row.color, settings.accentColor),
      iconName: normalizeWorkspaceIconName(row.icon_name, WORKSPACE_FOLDER_ICON),
      posX: clampWorkspaceCoordinate(row.pos_x, defaults.posX),
      posY: clampWorkspaceCoordinate(row.pos_y, defaults.posY),
      sortOrder: row && Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : index,
      isVisible: row.is_visible !== 0
    };
    folderIdMap.set(Number(row.id), folder.id);
    return folder;
  });
  const moduleRows = new Map();
  rows.forEach((row) => {
    if (normalizeString(row.item_type).toLowerCase() !== 'module') return;
    const key = normalizeString(row.module_key);
    if (!key || moduleRows.has(key)) return;
    moduleRows.set(key, row);
  });
  const modulesState = safeModules.map((module, index) => {
    const defaults = defaultModuleMap.get(module.key) || {};
    const row = moduleRows.get(module.key);
    return {
      moduleKey: module.key,
      name: module.name,
      desc: module.desc,
      href: module.href,
      iconName: normalizeWorkspaceIconName(row && row.icon_name, normalizeWorkspaceIconName(module.icon, 'default')),
      color: normalizeThemeColor(row && row.color, module.color || settings.accentColor),
      group: module.group || getWorkspaceModuleGroup(module.key),
      location: row && folderIdMap.has(Number(row.parent_folder_id)) ? 'folder' : 'desktop',
      folderId: row && folderIdMap.has(Number(row.parent_folder_id)) ? folderIdMap.get(Number(row.parent_folder_id)) : null,
      posX: row && folderIdMap.has(Number(row.parent_folder_id))
        ? null
        : clampWorkspaceCoordinate(row && row.pos_x, defaults.posX == null ? WORKSPACE_DESKTOP_START_X : defaults.posX),
      posY: row && folderIdMap.has(Number(row.parent_folder_id))
        ? null
        : clampWorkspaceCoordinate(row && row.pos_y, defaults.posY == null ? WORKSPACE_DESKTOP_START_Y : defaults.posY),
      sortOrder: row && Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : index,
      isVisible: row ? row.is_visible !== 0 : true
    };
  });

  return {
    settings,
    folders,
    modules: modulesState
  };
}

function sanitizeWorkspacePayload(rawState, modules, companyBrand) {
  const safeModules = Array.isArray(modules) ? modules.slice(0, WORKSPACE_MAX_MODULES) : [];
  const defaultState = buildDefaultWorkspaceLayout(safeModules);
  const defaultModuleMap = new Map(defaultState.modules.map((entry) => [entry.moduleKey, entry]));
  const fallbackSettings = buildWorkspaceSettingsFallback(companyBrand);
  const settings = normalizeWorkspaceSettings(rawState && rawState.settings ? rawState.settings : rawState, fallbackSettings);
  settings.dockModules = resolveWorkspaceDockModules(settings.dockModules, safeModules, fallbackSettings.dockModules);
  const rawFolders = rawState && Array.isArray(rawState.folders) ? rawState.folders : [];
  const folders = [];
  const folderIds = new Set();

  rawFolders.slice(0, WORKSPACE_MAX_FOLDERS).forEach((folder, index) => {
    const tempId = normalizeString(folder && (folder.id || folder.tempId || folder.temp_id)) || `folder:new:${index + 1}`;
    if (folderIds.has(tempId)) return;
    folderIds.add(tempId);
    const defaults = buildWorkspaceGridPosition(index, { startX: 96, startY: 96 });
    const rawPosX = folder && Object.prototype.hasOwnProperty.call(folder, 'posX') ? folder.posX : folder && folder.pos_x;
    const rawPosY = folder && Object.prototype.hasOwnProperty.call(folder, 'posY') ? folder.posY : folder && folder.pos_y;
    const rawSortOrder = folder && Object.prototype.hasOwnProperty.call(folder, 'sortOrder') ? folder.sortOrder : folder && folder.sort_order;
    folders.push({
      tempId,
      folderName: normalizeString(folder && (folder.name || folder.folderName || folder.folder_name)).slice(0, 42) || `Carpeta ${folders.length + 1}`,
      iconName: normalizeWorkspaceIconName(folder && (folder.iconName || folder.icon_name), WORKSPACE_FOLDER_ICON),
      color: normalizeThemeColor(folder && folder.color, settings.accentColor),
      posX: clampWorkspaceCoordinate(rawPosX, defaults.posX),
      posY: clampWorkspaceCoordinate(rawPosY, defaults.posY),
      sortOrder: Number.isFinite(Number(rawSortOrder)) ? Number(rawSortOrder) : folders.length,
      isVisible: normalizeBooleanFlag(folder && (Object.prototype.hasOwnProperty.call(folder, 'isVisible') ? folder.isVisible : folder.is_visible), true)
    });
  });

  const rawModules = rawState && Array.isArray(rawState.modules) ? rawState.modules : [];
  const incomingModules = new Map();
  rawModules.forEach((entry) => {
    const key = normalizeString(entry && (entry.moduleKey || entry.module_key));
    if (!key || incomingModules.has(key)) return;
    incomingModules.set(key, entry || {});
  });

  const preparedModules = safeModules.map((module) => {
    const defaults = defaultModuleMap.get(module.key) || {};
    const entry = incomingModules.get(module.key) || defaults;
    const rawPosX = entry && Object.prototype.hasOwnProperty.call(entry, 'posX') ? entry.posX : entry && entry.pos_x;
    const rawPosY = entry && Object.prototype.hasOwnProperty.call(entry, 'posY') ? entry.posY : entry && entry.pos_y;
    const rawSortOrder = entry && Object.prototype.hasOwnProperty.call(entry, 'sortOrder') ? entry.sortOrder : entry && entry.sort_order;
    let location = normalizeWorkspaceLocation(entry && entry.location, defaults.location || 'desktop');
    let folderId = null;
    if (location === 'folder') {
      const requestedFolderId = normalizeString(entry && (entry.folderId || entry.folder_id));
      if (requestedFolderId && folderIds.has(requestedFolderId)) {
        folderId = requestedFolderId;
      } else {
        location = 'desktop';
      }
    }
    return {
      moduleKey: module.key,
      iconName: normalizeWorkspaceIconName(entry && (entry.iconName || entry.icon_name), normalizeWorkspaceIconName(module.icon, 'default')),
      color: normalizeThemeColor(entry && entry.color, module.color || settings.accentColor),
      location,
      folderId,
      posX: location === 'desktop'
        ? clampWorkspaceCoordinate(rawPosX, defaults.posX == null ? WORKSPACE_DESKTOP_START_X : defaults.posX)
        : null,
      posY: location === 'desktop'
        ? clampWorkspaceCoordinate(rawPosY, defaults.posY == null ? WORKSPACE_DESKTOP_START_Y : defaults.posY)
        : null,
      sortOrder: Number.isFinite(Number(rawSortOrder))
        ? Number(rawSortOrder)
        : (defaults.sortOrder == null ? 999 : defaults.sortOrder),
      isVisible: normalizeBooleanFlag(entry && (Object.prototype.hasOwnProperty.call(entry, 'isVisible') ? entry.isVisible : entry.is_visible), true)
    };
  });

  return {
    settings,
    folders,
    modules: preparedModules
  };
}

function saveUserWorkspaceState(userId, companyId, companyBrand, modules, rawState, callback) {
  if (!userId || !companyId) {
    callback(new Error('Missing user or company'));
    return;
  }
  const payload = sanitizeWorkspacePayload(rawState, modules, companyBrand);
  const settings = payload.settings;
  const folders = payload.folders;
  const moduleItems = payload.modules;

  enqueueDbTransaction((finish) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(
        `INSERT INTO user_workspace_settings
           (company_id, user_id, dock_enabled, dock_position, dock_mode, dock_auto_hide, dock_size, show_labels,
            theme_color, accent_color, background_color, dock_color, dock_modules,
            icon_style, icon_size, use_glass_effect, layout_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, company_id) DO UPDATE SET
           dock_enabled = excluded.dock_enabled,
           dock_position = excluded.dock_position,
           dock_mode = excluded.dock_mode,
           dock_auto_hide = excluded.dock_auto_hide,
           dock_size = excluded.dock_size,
           show_labels = excluded.show_labels,
           theme_color = excluded.theme_color,
           accent_color = excluded.accent_color,
           background_color = excluded.background_color,
           dock_color = excluded.dock_color,
           dock_modules = excluded.dock_modules,
           icon_style = excluded.icon_style,
           icon_size = excluded.icon_size,
           use_glass_effect = excluded.use_glass_effect,
           layout_mode = excluded.layout_mode,
           updated_at = CURRENT_TIMESTAMP`,
        [
          companyId,
          userId,
          settings.dockEnabled ? 1 : 0,
          settings.dockPosition,
          settings.dockMode,
          settings.dockAutoHide ? 1 : 0,
          settings.dockSize || settings.iconSize,
          settings.showLabels ? 1 : 0,
          settings.themeColor,
          settings.accentColor,
          settings.backgroundColor,
          settings.dockColor,
          JSON.stringify(Array.isArray(settings.dockModules) ? settings.dockModules : []),
          settings.iconStyle,
          settings.iconSize,
          settings.useGlassEffect ? 1 : 0,
          settings.layoutMode
        ],
        (settingsErr) => {
          if (settingsErr) {
            rollbackTransaction(finish, () => callback(settingsErr));
            return;
          }
          db.run(
            'DELETE FROM user_workspace_items WHERE user_id = ? AND company_id = ?',
            [userId, companyId],
            (deleteErr) => {
              if (deleteErr) {
                rollbackTransaction(finish, () => callback(deleteErr));
                return;
              }

              const folderIdMap = new Map();
              const insertFolder = (index) => {
                if (index >= folders.length) {
                  insertModule(0);
                  return;
                }
                const folder = folders[index];
                db.run(
                  `INSERT INTO user_workspace_items
                     (company_id, user_id, item_type, module_key, folder_name, icon_name, color, pos_x, pos_y,
                      sort_order, parent_folder_id, is_visible, created_at, updated_at)
                   VALUES (?, ?, 'folder', NULL, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                  [
                    companyId,
                    userId,
                    folder.folderName,
                    folder.iconName,
                    folder.color,
                    folder.posX,
                    folder.posY,
                    folder.sortOrder,
                    folder.isVisible ? 1 : 0
                  ],
                  function onFolderInserted(folderErr) {
                    if (folderErr) {
                      rollbackTransaction(finish, () => callback(folderErr));
                      return;
                    }
                    folderIdMap.set(folder.tempId, this.lastID);
                    insertFolder(index + 1);
                  }
                );
              };

              const insertModule = (index) => {
                if (index >= moduleItems.length) {
                  commitTransaction(finish, (commitErr) => callback(commitErr || null));
                  return;
                }
                const item = moduleItems[index];
                const parentFolderId = item.location === 'folder' ? folderIdMap.get(item.folderId) || null : null;
                db.run(
                  `INSERT INTO user_workspace_items
                     (company_id, user_id, item_type, module_key, folder_name, icon_name, color, pos_x, pos_y,
                      sort_order, parent_folder_id, is_visible, created_at, updated_at)
                   VALUES (?, ?, 'module', ?, NULL, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                  [
                    companyId,
                    userId,
                    item.moduleKey,
                    item.iconName,
                    item.color,
                    item.location === 'desktop' ? item.posX : null,
                    item.location === 'desktop' ? item.posY : null,
                    item.sortOrder,
                    parentFolderId,
                    item.isVisible ? 1 : 0
                  ],
                  (itemErr) => {
                    if (itemErr) {
                      rollbackTransaction(finish, () => callback(itemErr));
                      return;
                    }
                    insertModule(index + 1);
                  }
                );
              };

              insertFolder(0);
            }
          );
        }
      );
    });
  });
}

function saveUserWorkspaceSettingsOnly(userId, companyId, companyBrand, workspaceModules, rawSettings, callback) {
  if (!userId || !companyId) {
    callback(new Error('Missing user or company'));
    return;
  }
  const settings = normalizeWorkspaceSettings(
    rawSettings && rawSettings.settings ? rawSettings.settings : rawSettings,
    buildWorkspaceSettingsFallback(companyBrand)
  );
  settings.dockModules = resolveWorkspaceDockModules(settings.dockModules, workspaceModules, settings.dockModules);

  db.run(
    `INSERT INTO user_workspace_settings
       (company_id, user_id, dock_enabled, dock_position, dock_mode, dock_auto_hide, dock_size, show_labels,
        theme_color, accent_color, background_color, dock_color, dock_modules,
        icon_style, icon_size, use_glass_effect, layout_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, company_id) DO UPDATE SET
       dock_enabled = excluded.dock_enabled,
       dock_position = excluded.dock_position,
       dock_mode = excluded.dock_mode,
       dock_auto_hide = excluded.dock_auto_hide,
       dock_size = excluded.dock_size,
       show_labels = excluded.show_labels,
       theme_color = excluded.theme_color,
       accent_color = excluded.accent_color,
       background_color = excluded.background_color,
       dock_color = excluded.dock_color,
       dock_modules = excluded.dock_modules,
       icon_style = excluded.icon_style,
       icon_size = excluded.icon_size,
       use_glass_effect = excluded.use_glass_effect,
       layout_mode = excluded.layout_mode,
       updated_at = CURRENT_TIMESTAMP`,
    [
      companyId,
      userId,
      settings.dockEnabled ? 1 : 0,
      settings.dockPosition,
      settings.dockMode,
      settings.dockAutoHide ? 1 : 0,
      settings.dockSize || settings.iconSize,
      settings.showLabels ? 1 : 0,
      settings.themeColor,
      settings.accentColor,
      settings.backgroundColor,
      settings.dockColor,
      JSON.stringify(Array.isArray(settings.dockModules) ? settings.dockModules : []),
      settings.iconStyle,
      settings.iconSize,
      settings.useGlassEffect ? 1 : 0,
      settings.layoutMode
    ],
    (err) => callback(err || null)
  );
}

function buildWorkspaceLabels(lang) {
  const isEn = lang === 'en';
  return {
    eyebrow: isEn ? 'Workspace' : 'Escritorio',
    title: isEn ? 'Main desktop' : 'Escritorio principal',
    subtitle: isEn
      ? 'Open your permitted modules from a modern floating dock.'
      : 'Abre tus modulos permitidos desde un dock flotante moderno.',
    save: isEn ? 'Save position' : 'Guardar posición',
    restore: isEn ? 'Restore default' : 'Restaurar defecto',
    settings: isEn ? 'Dock settings' : 'Ajustes del dock',
    edit: isEn ? 'Edit desktop' : 'Editar escritorio',
    createFolder: isEn ? 'Create folder' : 'Crear carpeta',
    saveChanges: isEn ? 'Save changes' : 'Guardar cambios',
    cancel: isEn ? 'Cancel' : 'Cancelar',
    restorePositions: isEn ? 'Restore default positions' : 'Restaurar posiciones por defecto',
    close: isEn ? 'Close' : 'Cerrar',
    openModule: isEn ? 'Open module' : 'Abrir módulo',
    openFolder: isEn ? 'Open folder' : 'Abrir carpeta',
    folder: isEn ? 'Folder' : 'Carpeta',
    folderName: isEn ? 'Folder name' : 'Nombre de carpeta',
    renameFolder: isEn ? 'Rename folder' : 'Renombrar carpeta',
    deleteFolder: isEn ? 'Delete folder' : 'Eliminar carpeta',
    deleteFolderConfirm: isEn ? 'Delete this folder? Modules inside will return to the desktop.' : '¿Eliminar esta carpeta? Los módulos internos volverán al escritorio.',
    emptyFolder: isEn ? 'This folder is empty.' : 'Esta carpeta está vacía.',
    moveOutFolder: isEn ? 'Move out' : 'Sacar',
    moveUp: isEn ? 'Move up' : 'Subir',
    moveDown: isEn ? 'Move down' : 'Bajar',
    noModules: isEn ? 'No modules are available for this user.' : 'No hay módulos disponibles para este usuario.',
    themeTitle: isEn ? 'Visual settings' : 'Configuración visual',
    themeDesc: isEn ? 'Adjust the dock, colors, icon size and desktop mode.' : 'Ajusta dock, colores, tamaño de iconos y modo del escritorio.',
    dockPosition: isEn ? 'Dock position' : 'Posición de dock',
    dockEnabled: isEn ? 'Enable global dock' : 'Activar dock global',
    dockMode: isEn ? 'Dock mode' : 'Modo del dock',
    themeColor: isEn ? 'Theme color' : 'Color de tema',
    accentColor: isEn ? 'Accent color' : 'Color de acento',
    backgroundColor: isEn ? 'Background color' : 'Color de fondo',
    dockColor: isEn ? 'Dock color' : 'Color de dock',
    iconSize: isEn ? 'Icon size' : 'Tamaño de icono',
    iconStyle: isEn ? 'Icon style' : 'Estilo de icono',
    glassEffect: isEn ? 'Glass effect' : 'Efecto glass',
    visualMode: isEn ? 'Mode' : 'Modo',
    lightMode: isEn ? 'Light' : 'Claro',
    darkMode: isEn ? 'Dark' : 'Oscuro',
    saveVisualSettings: isEn ? 'Save settings' : 'Guardar configuración',
    restoreVisualDefaults: isEn ? 'Restore visual defaults' : 'Restaurar visual por defecto',
    left: isEn ? 'Left' : 'Izquierda',
    right: isEn ? 'Right' : 'Derecha',
    top: isEn ? 'Top' : 'Arriba',
    bottom: isEn ? 'Bottom' : 'Abajo',
    centerTop: isEn ? 'Center top' : 'Centro arriba',
    centerBottom: isEn ? 'Center bottom' : 'Centro abajo',
    fixedMode: isEn ? 'Fixed' : 'Fijo',
    autoHideMode: isEn ? 'Auto-hide' : 'Auto-hide',
    expandableMode: isEn ? 'Expandable' : 'Expandible',
    showLabels: isEn ? 'Show labels' : 'Mostrar nombres',
    soft: isEn ? 'Soft' : 'Suave',
    solid: isEn ? 'Solid' : 'Sólido',
    outline: isEn ? 'Outline' : 'Contorno',
    modulesTitle: isEn ? 'Allowed modules' : 'Modulos permitidos',
    modulesDesc: isEn ? 'Only modules enabled for this user and company are shown.' : 'Solo se muestran módulos habilitados para este usuario y empresa.',
    dockAppsTitle: isEn ? 'Apps in dock' : 'Apps en el dock',
    dockAppsDesc: isEn ? 'Choose which permitted apps appear in the dock.' : 'Elige qué aplicaciones permitidas aparecen en el dock.',
    dockAppsEmpty: isEn ? 'No apps are available for this dock.' : 'No hay aplicaciones disponibles para este dock.',
    dockHint: isEn ? 'Dock position saved for your user in this company.' : 'La posición del dock se guarda para tu usuario en esta empresa.',
    dockSettingsTitle: isEn ? 'Dock position' : 'Posicion del dock',
    dockSettingsDesc: isEn ? 'Choose where the floating dock appears for this user and company.' : 'Elige donde aparece el dock flotante para este usuario y empresa.',
    saveSettings: isEn ? 'Save settings' : 'Guardar ajustes',
    saved: isEn ? 'Workspace settings saved.' : 'Ajustes del escritorio guardados.',
    saving: isEn ? 'Saving...' : 'Guardando...',
    saveFailed: isEn ? 'Workspace settings could not be saved.' : 'No se pudieron guardar los ajustes del escritorio.',
    resetConfirm: isEn ? 'Restore default icon positions?' : '¿Restaurar las posiciones por defecto de los iconos?',
    resetFailed: isEn ? 'Default positions could not be restored.' : 'No se pudieron restaurar las posiciones por defecto.',
    visualResetConfirm: isEn ? 'Restore default visual settings?' : '¿Restaurar la configuración visual por defecto?',
    visualResetFailed: isEn ? 'Visual settings could not be restored.' : 'No se pudo restaurar la configuración visual.',
    desktopHint: isEn
      ? 'Select a module icon to open it.'
      : 'Selecciona un icono de modulo para abrirlo.',
    editHint: isEn
      ? 'Icon movement is reserved for the next phase.'
      : 'El movimiento de iconos queda preparado para la siguiente fase.',
    ready: isEn ? 'Ready to use' : 'Listo para usar',
    editing: isEn ? 'Editing desktop' : 'Editando escritorio'
  };
}

function filterWorkspaceModulesForPermissions(modules, permissionMap, isMaster) {
  const safeModules = Array.isArray(modules) ? modules : [];
  return safeModules.filter((module) => {
    if (!module || !module.key) return false;
    const key = normalizeString(module.key);
    if (!key || key === launcher_SETTINGS_KEY || key === 'dashboard') return false;
    if (key === 'master') return Boolean(isMaster);
    if (key.startsWith('packages_status_')) {
      return hasPermission(permissionMap, 'packages', 'view');
    }
    return hasPermission(permissionMap, key, 'view');
  });
}

function buildWorkspaceResponse(req, res, callback) {
  const companyId = getCompanyId(req);
  const userId = req.session && req.session.user ? req.session.user.id : null;
  if (!companyId || !userId) {
    callback(new Error('Missing user or company'));
    return;
  }
  buildlauncherModules(db, res.locals.t, req.session.permissionMap, Boolean(req.session.master), (modules) => {
    const workspaceModules = filterWorkspaceModulesForPermissions(modules, req.session.permissionMap, Boolean(req.session.master));
    getCompanyBrandById(companyId, (companyBrand) => {
      getUserWorkspaceSettings(userId, companyId, (workspaceSettings) => {
        getUserWorkspaceItems(userId, companyId, (workspaceItems) => {
          const workspaceState = buildWorkspaceState(workspaceModules, companyBrand, workspaceSettings, workspaceItems);
          callback(null, {
            companyBrand,
            workspaceState,
            icons: launcher_ICON_MAP,
            modules: workspaceModules.map((mod) => ({
              key: mod.key,
              name: mod.name,
              href: mod.href,
              icon: mod.icon,
              color: mod.color
            }))
          });
        });
      });
    });
  });
}

function renderWorkspacePage(req, res, options = {}) {
  buildWorkspaceResponse(req, res, (err, payload) => {
    if (err) {
      res.status(500).send('Workspace unavailable');
      return;
    }
    const bootstrap = JSON.stringify({
      labels: buildWorkspaceLabels(res.locals.lang),
      companyBrand: payload.companyBrand,
      icons: payload.icons,
      workspaceState: payload.workspaceState,
      endpoints: {
        save: '/workspace/save',
        reset: '/workspace/reset',
        state: '/workspace/state',
        settingsReset: '/workspace/settings/reset'
      },
      csrfToken: res.locals.csrfToken,
      settingsPanelOpen: Boolean(options.settingsPanelOpen)
    }).replace(/</g, '\\u003c');

    res.render('workspace', {
      companyBrand: payload.companyBrand,
      workspaceBootstrap: bootstrap,
      workspaceLabels: buildWorkspaceLabels(res.locals.lang),
      settingsPanelOpen: Boolean(options.settingsPanelOpen)
    });
  });
}

function buildDashboardViewModel(t, modules, stats) {
  const safeModules = Array.isArray(modules) ? modules : [];
  const primaryModules = safeModules.filter((mod) => mod && mod.key !== launcher_SETTINGS_KEY);
  const quickActions = primaryModules.slice(0, 4);
  const secondaryActions = primaryModules.slice(4, 10);
  const statCards = [
    { key: 'packages', label: t('launcher.stats.total_packages'), value: Number(stats && stats.packageCount) || 0 },
    { key: 'today', label: t('launcher.stats.received_today'), value: Number(stats && stats.packageReceivedToday) || 0 },
    { key: 'items', label: t('launcher.stats.total_items'), value: Number(stats && stats.itemCount) || 0 },
    { key: 'low_stock', label: t('launcher.stats.low_stock'), value: Number(stats && stats.lowStock) || 0 }
  ];
  const alerts = [];

  if ((stats && Number(stats.lowStock)) > 0) {
    alerts.push({
      tone: 'warning',
      title: t('launcher.alerts.low_stock.title', { count: Number(stats.lowStock) }),
      description: t('launcher.alerts.low_stock.desc'),
      href: '/inventory',
      cta: t('launcher.alerts.review')
    });
  }
  if ((stats && Number(stats.packageInCustoms)) > 0) {
    alerts.push({
      tone: 'info',
      title: t('launcher.alerts.customs.title', { count: Number(stats.packageInCustoms) }),
      description: t('launcher.alerts.customs.desc'),
      href: '/packages',
      cta: t('launcher.alerts.review')
    });
  }
  if ((stats && Number(stats.packageReadyDelivery)) > 0) {
    alerts.push({
      tone: 'success',
      title: t('launcher.alerts.delivery.title', { count: Number(stats.packageReadyDelivery) }),
      description: t('launcher.alerts.delivery.desc'),
      href: '/packages',
      cta: t('launcher.alerts.review')
    });
  }
  if (!alerts.length) {
    alerts.push({
      tone: 'neutral',
      title: t('launcher.alerts.clear.title'),
      description: t('launcher.alerts.clear.desc'),
      href: '/dashboard',
      cta: t('launcher.alerts.refresh')
    });
  }

  return {
    heroMetrics: statCards.slice(0, 3),
    statCards,
    quickActions,
    secondaryActions,
    alerts
  };
}

function normalizeNoteColor(value, fallback) {
  const raw = normalizeString(value);
  if (/^#[0-9a-fA-F]{3}$/.test(raw) || /^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  return fallback || '#fff6a6';
}

function sanitizeLauncherNotes(rawNotes) {
  const list = Array.isArray(rawNotes) ? rawNotes : [];
  const maxNotes = 50;
  const safe = [];
  list.slice(0, maxNotes).forEach((note, index) => {
    const id = normalizeString(note && note.id);
    const externalId = id || `note_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const text = normalizeString(note && note.text).slice(0, 1000);
    const color = normalizeNoteColor(note && note.color, '#fff6a6');
    const position = Number.isFinite(Number(note && note.position)) ? Number(note.position) : index;
    safe.push({ externalId, text, color, position });
  });
  return safe;
}

function getlauncherNotes(userId, companyId, callback) {
  if (!userId || !companyId) return callback([]);
  db.all(
    `SELECT external_id, text, color, position
     FROM launcher_notes
     WHERE user_id = ? AND company_id = ?
     ORDER BY position ASC, updated_at DESC`,
    [userId, companyId],
    (err, rows) => {
      if (err || !rows) return callback([]);
      const notes = rows.map((row) => ({
        id: row.external_id,
        text: row.text || '',
        color: row.color || null,
        position: Number.isFinite(Number(row.position)) ? Number(row.position) : 0
      }));
      return callback(notes);
    }
  );
}

function savelauncherNotes(userId, companyId, rawNotes, callback) {
  if (!userId || !companyId) {
    if (callback) callback(new Error('Missing user or company'));
    return;
  }
  const notes = sanitizeLauncherNotes(rawNotes);
  const ids = notes.map((note) => note.externalId);
  let pending = 1 + notes.length;
  let failed = false;

  const done = (finish, err) => {
    if (failed) return;
    if (err) {
      failed = true;
      rollbackTransaction(finish, () => callback && callback(err));
      return;
    }
    pending -= 1;
    if (pending === 0) {
      commitTransaction(finish, (commitErr) => callback && callback(commitErr));
    }
  };

  enqueueDbTransaction((finish) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      if (!ids.length) {
        db.run(
          'DELETE FROM launcher_notes WHERE user_id = ? AND company_id = ?',
          [userId, companyId],
          (err) => done(finish, err)
        );
      } else {
        const placeholders = ids.map(() => '?').join(', ');
        db.run(
          `DELETE FROM launcher_notes
           WHERE user_id = ? AND company_id = ? AND external_id NOT IN (${placeholders})`,
          [userId, companyId, ...ids],
          (err) => done(finish, err)
        );
      }

      notes.forEach((note) => {
        db.run(
          `INSERT INTO launcher_notes (external_id, user_id, company_id, text, color, position)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(external_id)
           DO UPDATE SET
             user_id = excluded.user_id,
             company_id = excluded.company_id,
             text = excluded.text,
             color = excluded.color,
             position = excluded.position,
             updated_at = CURRENT_TIMESTAMP`,
          [note.externalId, userId, companyId, note.text || null, note.color || null, note.position],
          (err) => done(finish, err)
        );
      });
    });
  });
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHexColor(value) {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function sanitizePlannerItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const safe = [];
  items.forEach((item, idx) => {
    const text = normalizeString(item && item.text).slice(0, 200);
    if (!text) return;
    const done = Boolean(item && item.done);
    const id = normalizeString(item && item.id) || `item_${Date.now()}_${idx}_${Math.random().toString(16).slice(2)}`;
    safe.push({ id, text, done });
  });
  return safe.slice(0, 30);
}

function parsePlannerItems(rawText) {
  const text = normalizeString(rawText);
  let items = [];
  if (!text) return items;
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.items)) {
      items = sanitizePlannerItems(parsed.items);
    } else if (text) {
      items = sanitizePlannerItems([{ text }]);
    }
  } catch (parseErr) {
    items = sanitizePlannerItems([{ text }]);
  }
  return items;
}

function sanitizeLauncherPlannerEntries(rawEntries) {
  const list = Array.isArray(rawEntries) ? rawEntries : [];
  const safe = [];
  const seen = new Set();
  list.forEach((entry) => {
    const date = normalizeString(entry && entry.date);
    if (!date || !isIsoDate(date) || seen.has(date)) return;
    const items = sanitizePlannerItems(entry && entry.items);
    safe.push({ date, items });
    seen.add(date);
  });
  return safe;
}

function getlauncherPlannerEntries(userId, companyId, startDate, endDate, callback) {
  if (!userId || !companyId || !isIsoDate(startDate) || !isIsoDate(endDate)) return callback([]);
  db.all(
    `SELECT entry_date, text
     FROM launcher_planner_entries
     WHERE user_id = ? AND company_id = ? AND entry_date BETWEEN ? AND ?
     ORDER BY entry_date ASC`,
    [userId, companyId, startDate, endDate],
    (err, rows) => {
      if (err || !rows) return callback([]);
      const entries = rows.map((row) => ({
        date: row.entry_date,
        items: parsePlannerItems(row.text || '')
      }));
      return callback(entries);
    }
  );
}

function getlauncherPlannerEntriesBefore(userId, companyId, beforeDate, callback) {
  if (!userId || !companyId || !isIsoDate(beforeDate)) return callback([]);
  db.all(
    `SELECT entry_date, text
     FROM launcher_planner_entries
     WHERE user_id = ? AND company_id = ? AND entry_date < ?
     ORDER BY entry_date ASC`,
    [userId, companyId, beforeDate],
    (err, rows) => {
      if (err || !rows) return callback([]);
      const entries = rows.map((row) => ({
        date: row.entry_date,
        items: parsePlannerItems(row.text || '')
      }));
      return callback(entries);
    }
  );
}

function savelauncherPlannerEntries(userId, companyId, rawEntries, callback) {
  if (!userId || !companyId) {
    if (callback) callback(new Error('Missing user or company'));
    return;
  }
  const entries = sanitizeLauncherPlannerEntries(rawEntries);
  let pending = 1 + entries.length;
  let failed = false;

  const done = (finish, err) => {
    if (failed) return;
    if (err) {
      failed = true;
      rollbackTransaction(finish, () => callback && callback(err));
      return;
    }
    pending -= 1;
    if (pending === 0) {
      commitTransaction(finish, (commitErr) => callback && callback(commitErr));
    }
  };

  enqueueDbTransaction((finish) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      if (!entries.length) {
        commitTransaction(finish, (commitErr) => callback && callback(commitErr));
        return;
      }
      entries.forEach((entry) => {
        const payload = JSON.stringify({ items: entry.items || [] });
        if (!entry.items || entry.items.length === 0) {
          db.run(
            'DELETE FROM launcher_planner_entries WHERE user_id = ? AND company_id = ? AND entry_date = ?',
            [userId, companyId, entry.date],
            (err) => done(finish, err)
          );
          return;
        }
        db.run(
          `INSERT INTO launcher_planner_entries (user_id, company_id, entry_date, text)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, company_id, entry_date)
           DO UPDATE SET
             text = excluded.text,
             updated_at = CURRENT_TIMESTAMP`,
          [userId, companyId, entry.date, payload],
          (err) => done(finish, err)
        );
      });
    });
  });
}

function buildPackageUrl(req, packageId) {
  const host = req.get('host');
  if (!host) return `/packages/${packageId}`;
  return `${req.protocol}://${host}/packages/${packageId}`;
}

function buildPackageInvoiceUploadUrl(req, packageId, companyId) {
  const token = signInvoiceUploadToken(packageId, companyId, INVOICE_UPLOAD_TOKEN_TTL_MS);
  if (!token) return null;
  const host = req.get('host');
  const pathUrl = `/packages/invoice/upload/${token}`;
  if (!host) return pathUrl;
  return `${req.protocol}://${host}${pathUrl}`;
}

function formatWhatsappNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) return null;
  return digits;
}

function buildInvoiceRequestMessage(trackingNumber, uploadUrl) {
  const tracking = trackingNumber || '-';
  const link = uploadUrl || '';
  return [
    `El tracking nÃºmero ${tracking} tiene pendiente la factura de compra favor de subirla para que su paquete pueda ser enviado`,
    'gracias',
    link
  ].filter(Boolean).join('\n');
}

function sendWhatsappMessage(phone, message, callback) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    return callback(new Error('whatsapp_not_configured'));
  }
  const to = formatWhatsappNumber(phone);
  if (!to) return callback(new Error('invalid_phone'));
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message }
  });
  const options = {
    hostname: 'graph.facebook.com',
    path: `/v19.0/${phoneId}/messages`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  const req = https.request(options, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        return callback(null, true);
      }
      return callback(new Error(`whatsapp_error_${res.statusCode}`));
    });
  });
  req.on('error', (err) => callback(err));
  req.write(payload);
  req.end();
}

let emailTransport = null;
function getEmailTransport() {
  if (emailTransport) return emailTransport;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    return null;
  }
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  if (!host || !port) return null;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = port === 465;
  emailTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined
  });
  return emailTransport;
}

function sendInvoiceEmail(to, subject, body, callback) {
  if (!to) return callback(new Error('invalid_email'));
  const transport = getEmailTransport();
  if (!transport) return callback(new Error('email_not_configured'));
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) return callback(new Error('email_not_configured'));
  transport.sendMail(
    {
      from,
      to,
      subject,
      text: body
    },
    callback
  );
}

function summarizeUploadedFiles(files) {
  if (!files) return null;
  if (Array.isArray(files)) {
    return files.map((file) => ({
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path
    }));
  }
  const summary = {};
  Object.keys(files).forEach((key) => {
    summary[key] = (files[key] || []).map((file) => ({
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path
    }));
  });
  return summary;
}

function formatSqliteError(err) {
  if (!err) return 'Error desconocido en la base de datos.';
  const code = err.code || 'SQLITE_ERROR';
  const message = String(err.message || '');
  const lower = message.toLowerCase();
  if (lower.includes('no such table')) {
    return 'No se encontrÃ³ la tabla de paquetes en la base de datos.';
  }
  if (lower.includes('no such column')) {
    return `Falta una columna en la tabla de paquetes (${message}).`;
  }
  if (code === 'SQLITE_CONSTRAINT') {
    if (lower.includes('unique')) return 'Existe un valor duplicado que viola una restricciÃ³n Ãºnica.';
    if (lower.includes('foreign key')) return 'El cliente seleccionado no existe en esta empresa.';
    return 'Se violÃ³ una restricciÃ³n de la base de datos.';
  }
  if (code === 'SQLITE_MISMATCH') {
    return 'Uno o mÃ¡s datos tienen un formato invÃ¡lido.';
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return 'La base de datos estÃ¡ ocupada, intÃ©ntelo nuevamente.';
  }
  return `Error de base de datos (${code}).`;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parseJsonList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function normalizeModuleSelection(input, allowedSet) {
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  const seen = new Set();
  const selected = [];
  raw.forEach((entry) => {
    const code = normalizeString(entry);
    if (!code || (allowedSet && !allowedSet.has(code))) return;
    if (seen.has(code)) return;
    seen.add(code);
    selected.push(code);
  });
  return selected;
}

const ALWAYS_ALLOWED_MODULES = new Set(['dashboard']);

function normalizeAllowedModules(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const normalized = [];
  list.forEach((entry) => {
    const code = normalizeString(entry);
    if (!code) return;
    if (seen.has(code)) return;
    seen.add(code);
    normalized.push(code);
  });
  if (!seen.has('dashboard')) {
    normalized.push('dashboard');
  }
  return normalized;
}

function loadBusinessActivities(callback) {
  db.all(
    'SELECT id, name, modules_json FROM business_activities ORDER BY name',
    (err, rows) => {
      const safe = err ? [] : rows || [];
      callback(safe);
    }
  );
}


function parseCarrierList(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueCarriers(list) {
  const seen = new Set();
  const result = [];
  list.forEach((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(entry);
  });
  return result;
}

function getCarrierOptions(companyId, callback) {
  const defaults = ['UPS', 'Amazon', 'USPS', 'FedEx', 'DHL'];
  if (!companyId) return callback(defaults);
  db.get(
    'SELECT carriers_text FROM carrier_settings WHERE company_id = ?',
    [companyId],
    (err, row) => {
      if (err || !row || !row.carriers_text) return callback(defaults);
      const parsed = uniqueCarriers(parseCarrierList(row.carriers_text));
      return callback(parsed.length ? parsed : defaults);
    }
  );
}

function getPackageSenderSettings(companyId, callback) {
  if (!companyId) return callback({ sender_name: null, store_name: null });
  db.get(
    'SELECT sender_name, store_name FROM package_sender_settings WHERE company_id = ?',
    [companyId],
    (err, row) => {
      if (err || !row) return callback({ sender_name: null, store_name: null });
      return callback({
        sender_name: normalizeString(row.sender_name) || null,
        store_name: normalizeString(row.store_name) || null
      });
    }
  );
}

function normalizeOption(value, options, fallback = '') {
  const normalized = normalizeString(value);
  if (!normalized) return fallback;
  if (options.includes(normalized)) return normalized;
  return fallback;
}

function normalizeDocumentType(value) {
  return normalizeOption(value, CUSTOMER_DOCUMENT_TYPES, 'NIT');
}

function resolveSatFields({ documentType, satVerifiedInput, satNameInput, satCheckedAtInput }) {
  if (documentType !== 'NIT') {
    return { sat_verified: 0, sat_name: null, sat_checked_at: null };
  }
  const verified = satVerifiedInput === '1' || satVerifiedInput === 1 || satVerifiedInput === true;
  if (!verified) {
    return { sat_verified: 0, sat_name: null, sat_checked_at: null };
  }
  const satName = normalizeString(satNameInput) || null;
  const satCheckedAt = satCheckedAtInput ? normalizeString(satCheckedAtInput) : null;
  return {
    sat_verified: 1,
    sat_name: satName,
    sat_checked_at: satCheckedAt || new Date().toISOString()
  };
}

function simulateSatLookup(documentNumber) {
  const normalized = normalizeString(documentNumber);
  if (!normalized || normalized.length < 4) {
    return { ok: false, manual: true, message: 'NIT invÃ¡lido o incompleto.', portal_url: SAT_PORTAL_URL };
  }
  const upper = normalized.toUpperCase();
  if (upper.includes('TEST') || normalized.endsWith('0')) {
    return { ok: true, name: `CONTRIBUYENTE ${normalized}` };
  }
  return { ok: false, manual: true, message: 'Consulta manual', portal_url: SAT_PORTAL_URL };
}

function requestSatLookup(documentNumber, callback) {
  const baseUrl = normalizeString(process.env.SAT_INTEGRATION_URL);
  if (!baseUrl) {
    return callback(null, { ok: false, manual: true, message: 'Consulta manual', portal_url: SAT_PORTAL_URL });
  }

  let url;
  try {
    url = new URL(baseUrl);
    url.searchParams.set('nit', documentNumber);
  } catch (err) {
    return callback(null, { ok: false, manual: true, message: 'Consulta manual', portal_url: SAT_PORTAL_URL });
  }

  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.get(
    url,
    { timeout: 4000 },
    (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.ok && parsed.name) {
            return callback(null, { ok: true, name: parsed.name });
          }
          const message = parsed && parsed.message ? String(parsed.message) : 'Consulta manual';
          return callback(null, { ok: false, manual: true, message, portal_url: SAT_PORTAL_URL });
        } catch (parseErr) {
          return callback(null, { ok: false, manual: true, message: 'Consulta manual', portal_url: SAT_PORTAL_URL });
        }
      });
    }
  );
  req.on('timeout', () => {
    req.destroy();
    callback(null, { ok: false, manual: true, message: 'Consulta manual', portal_url: SAT_PORTAL_URL });
  });
  req.on('error', () => {
    callback(null, { ok: false, manual: true, message: 'Consulta manual', portal_url: SAT_PORTAL_URL });
  });
}

function generatePortalCode(companyId, attempt, callback) {
  const safeAttempt = Number.isInteger(attempt) ? attempt : 0;
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  db.get(
    'SELECT id FROM customers WHERE portal_code = ? AND company_id = ?',
    [code, companyId],
    (err, row) => {
      if (err) return callback(err);
      if (row) {
        if (safeAttempt >= 6) return callback(new Error('portal_code_collision'));
        return generatePortalCode(companyId, safeAttempt + 1, callback);
      }
      return callback(null, code);
    }
  );
}

function generatePortalPassword() {
  return `CP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function generateCustomerCode(companyId, attempt, callback) {
  const safeAttempt = Number.isInteger(attempt) ? attempt : 0;
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  const code = `CLI-${year}-${rand}`;
  db.get(
    'SELECT id FROM customers WHERE customer_code = ? AND company_id = ?',
    [code, companyId],
    (err, row) => {
      if (err) return callback(err);
      if (row) {
        if (safeAttempt >= 6) return callback(new Error('customer_code_collision'));
        return generateCustomerCode(companyId, safeAttempt + 1, callback);
      }
      return callback(null, code);
    }
  );
}

function generateInternalCode(companyId, attempt, callback) {
  const safeAttempt = Number.isInteger(attempt) ? attempt : 0;
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  const code = `PKG-${year}-${rand}`;
  db.get(
    'SELECT id FROM packages WHERE internal_code = ? AND company_id = ?',
    [code, companyId],
    (err, row) => {
      if (err) return callback(err);
      if (row) {
        if (safeAttempt >= 6) return callback(new Error('internal_code_collision'));
        return generateInternalCode(companyId, safeAttempt + 1, callback);
      }
      return callback(null, code);
    }
  );
}

function generateInternalCodeForTable(table, companyId, attempt, callback) {
  const safeAttempt = Number.isInteger(attempt) ? attempt : 0;
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
  const code = `PKG-${year}-${rand}`;
  db.get(
    `SELECT id FROM ${table} WHERE internal_code = ? AND company_id = ?`,
    [code, companyId],
    (err, row) => {
      if (err) return callback(err);
      if (row) {
        if (safeAttempt >= 6) return callback(new Error('internal_code_collision'));
        return generateInternalCodeForTable(table, companyId, safeAttempt + 1, callback);
      }
      return callback(null, code);
    }
  );
}

function backfillPackageInternalCodes() {
  findPackagesTable((table) => {
    if (!table) return;
    db.all(
      `SELECT id, company_id FROM ${table} WHERE internal_code IS NULL OR TRIM(internal_code) = ''`,
      (err, rows) => {
        if (err || !rows || rows.length === 0) return;
        const next = (index) => {
          if (index >= rows.length) return;
          const row = rows[index];
          const companyId = row.company_id;
          if (!companyId) return next(index + 1);
          generateInternalCodeForTable(table, companyId, 0, (genErr, code) => {
            if (genErr || !code) return next(index + 1);
            db.run(`UPDATE ${table} SET internal_code = ? WHERE id = ?`, [code, row.id], () => {
              next(index + 1);
            });
          });
        };
        next(0);
      }
    );
  });
}

function backfillPackageDefaults() {
  findPackagesTable((table) => {
    if (!table) return;
    db.run(`UPDATE ${table} SET payment_status = 'pending' WHERE payment_status IS NULL`);
    db.run(
      `UPDATE ${table} SET invoice_status = CASE WHEN invoice_file IS NOT NULL THEN 'uploaded' ELSE 'pending' END WHERE invoice_status IS NULL`
    );
    db.run(
      `UPDATE ${table} SET status = ? WHERE status IS NULL OR TRIM(status) = ''`,
      [PACKAGE_STATUSES[0]]
    );
    db.run(
      `UPDATE ${table} SET status = ? WHERE status = ?`,
      [PACKAGE_STATUSES[0], 'Recibido en bodega']
    );
  });
}

function backfillCustomerPortalCodes() {
  findCustomerTable((table) => {
    if (!table) return;
    db.all(
      `SELECT id, company_id FROM ${table} WHERE portal_code IS NULL OR TRIM(portal_code) = ''`,
      (err, rows) => {
        if (err || !rows || rows.length === 0) return;
        const next = (index) => {
          if (index >= rows.length) return;
          const row = rows[index];
          if (!row.company_id) return next(index + 1);
          generatePortalCode(row.company_id, 0, (genErr, code) => {
            if (genErr || !code) return next(index + 1);
            db.run(`UPDATE ${table} SET portal_code = ? WHERE id = ?`, [code, row.id], () => next(index + 1));
          });
        };
        next(0);
      }
    );
  });
}

function backfillCustomerCodes() {
  findCustomerTable((table) => {
    if (!table) return;
    db.all(
      `SELECT id, company_id FROM ${table} WHERE customer_code IS NULL OR TRIM(customer_code) = ''`,
      (err, rows) => {
        if (err || !rows || rows.length === 0) return;
        const next = (index) => {
          if (index >= rows.length) return;
          const row = rows[index];
          if (!row.company_id) return next(index + 1);
          generateCustomerCode(row.company_id, 0, (genErr, code) => {
            if (genErr || !code) return next(index + 1);
            db.run(`UPDATE ${table} SET customer_code = ? WHERE id = ?`, [code, row.id], () => next(index + 1));
          });
        };
        next(0);
      }
    );
  });
}

function parseDateOnly(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    return new Date(year, month, day);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getTodayDateOnly() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isCompanyExpired(company) {
  if (!company || !company.active_until) return false;
  const untilDate = parseDateOnly(company.active_until);
  if (!untilDate) return false;
  return getTodayDateOnly() > untilDate;
}

function buildCompanyStatus(company) {
  if (company && (company.is_active === 0 || company.is_active === '0')) return 'inactive';
  return isCompanyExpired(company) ? 'expired' : 'active';
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user && getCompanyId(req)) {
    return next();
  }
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(403).send('Forbidden');
}

function requireMaster(req, res, next) {
  if (req.session && req.session.master) {
    return next();
  }
  if (req.session && req.session.user) {
    return res.status(403).send('Forbidden');
  }
  return res.redirect('/master/login');
}

function requireCustomer(req, res, next) {
  if (req.session && req.session.customer && req.session.customer.id) {
    return next();
  }
  return res.redirect('/customer/login');
}

function getUserPermissions(userId, companyId, callback) {
  db.all(
    `
    SELECT pm.code AS module_code, pa.code AS action_code
    FROM user_permissions up
    JOIN permission_modules pm ON pm.id = up.module_id AND pm.is_active = 1
    JOIN permission_actions pa ON pa.id = up.action_id AND pa.is_active = 1
    WHERE up.user_id = ? AND up.company_id = ?
    `,
    [userId, companyId],
    (err, rows) => {
      if (err) return callback(err);
      return callback(null, rows || []);
    }
  );
}

function ensureDashboardPermissionData(callback) {
  db.serialize(() => {
    db.run(
      `INSERT OR IGNORE INTO permission_modules (code, name, description) VALUES
      ('dashboard','Dashboard','Panel principal')`
    );
    db.run(
      `INSERT OR IGNORE INTO permission_actions (code, name, description) VALUES
      ('view','Ver','Acceso de lectura')`
    );
    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'dashboard' AND pa.code = 'view'`
    );
    db.get(
      `SELECT pm.id AS module_id, pa.id AS action_id
       FROM permission_modules pm
       JOIN permission_actions pa ON pa.code = 'view'
       WHERE pm.code = 'dashboard'`,
      (err, row) => {
        if (err) return callback(err);
        if (!row || !row.module_id || !row.action_id) {
          return callback(new Error('dashboard/view permission not found'));
        }
        return callback(null, row);
      }
    );
  });
}

function assignDefaultDashboardPermission(userId, companyId, callback) {
  ensureDashboardPermissionData((err, ids) => {
    if (err) return callback(err);
    db.run(
      'INSERT OR IGNORE INTO user_permissions (user_id, company_id, module_id, action_id) VALUES (?, ?, ?, ?)',
      [userId, companyId, ids.module_id, ids.action_id],
      (insErr) => callback(insErr || null)
    );
  });
}

function getPermissionMap(userId, companyId, allowedModules, callback) {
  const allowedList =
    Array.isArray(allowedModules) && allowedModules.length
      ? normalizeAllowedModules(allowedModules)
      : null;
  db.get(
    'SELECT role FROM users WHERE id = ? AND company_id = ?',
    [userId, companyId],
    (err, row) => {
      if (err || !row) return callback(err || new Error('User not found'));

      if (row.role === 'admin') {
        return callback(null, { isAdmin: true, modules: {}, allowedModules: allowedList });
      }

      getUserPermissions(userId, companyId, (permErr, rows) => {
        if (permErr) return callback(permErr);
        const map = { isAdmin: false, modules: {}, allowedModules: allowedList };
        rows.forEach((r) => {
          if (!map.modules[r.module_code]) {
            map.modules[r.module_code] = {};
          }
          map.modules[r.module_code][r.action_code] = true;
        });
        return callback(null, map);
      });
    }
  );
}

function isModuleAllowed(permissionMap, moduleCode) {
  if (!permissionMap) return false;
  if (!permissionMap.allowedModules || permissionMap.allowedModules.length === 0) return true;
  if (ALWAYS_ALLOWED_MODULES.has(moduleCode)) return true;
  return permissionMap.allowedModules.includes(moduleCode);
}

function hasPermission(permissionMap, moduleCode, actionCode) {
  if (!permissionMap) return false;
  if (!isModuleAllowed(permissionMap, moduleCode)) return false;
  if (permissionMap.isAdmin) return true;
  return Boolean(
    permissionMap.modules &&
    permissionMap.modules[moduleCode] &&
    permissionMap.modules[moduleCode][actionCode]
  );
}

function requirePermission(moduleCode, actionCode) {
  return (req, res, next) => {
    if (!req.session || !req.session.user || !getCompanyId(req)) {
      return res.redirect('/login');
    }
    const map = req.session.permissionMap || null;
    if (!hasPermission(map, moduleCode, actionCode)) {
      return res.status(403).send('Forbidden');
    }
    return next();
  };
}

const AI_ACTION_LABELS = {
  view: 'ver',
  create: 'crear',
  edit: 'editar',
  delete: 'eliminar',
  export: 'exportar',
  print: 'imprimir',
  search: 'buscar'
};

const AI_MODULE_LABELS = {
  packages: 'Paquetes',
  users: 'Usuarios',
  companies: 'Empresas',
  inventory: 'Inventario',
  manifests: 'Manifiestos',
  airway_bills: 'Guias aereas',
  rrhh: 'RRHH'
};

function resolveModuleByPath(pathname) {
  const pathValue = String(pathname || '');
  const rules = [
    { re: /^\/packages/, module: 'packages' },
    { re: /^\/users/, module: 'users' },
    { re: /^\/inventory/, module: 'inventory' },
    { re: /^\/categories/, module: 'inventory' },
    { re: /^\/brands/, module: 'inventory' },
    { re: /^\/rrhh/, module: 'rrhh' },
    { re: /^\/manifests/, module: 'manifests' },
    { re: /^\/airway-bills/, module: 'airway_bills' },
    { re: /^\/master/, module: 'companies' },
    { re: /^\/companies/, module: 'companies' }
  ];
  const found = rules.find((rule) => rule.re.test(pathValue));
  return found ? found.module : null;
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function loadAiHelpModule(companyId, moduleCode, callback) {
  if (!moduleCode) return callback(null, null);
  db.get(
    `SELECT *
     FROM ai_help_modules
     WHERE module_code = ? AND (company_id = ? OR company_id IS NULL)
     ORDER BY company_id DESC
     LIMIT 1`,
    [moduleCode, companyId],
    (err, row) => {
      if (err || !row) return callback(err || null, null);
      const payload = {
        module_code: row.module_code,
        module_name: row.module_name,
        description: row.description,
        actions: parseJsonField(row.actions_json, []),
        faqs: parseJsonField(row.faqs_json, []),
        help: parseJsonField(row.help_json, {})
      };
      return callback(null, payload);
    }
  );
}

function detectAiAction(question, helpData) {
  const text = String(question || '').toLowerCase();
  if (!text) return null;
  const keywords = [
    { action: 'delete', keys: ['eliminar', 'borrar', 'quitar', 'anular'] },
    { action: 'create', keys: ['crear', 'nuevo', 'agregar', 'registrar', 'alta'] },
    { action: 'edit', keys: ['editar', 'modificar', 'actualizar', 'cambiar'] },
    { action: 'export', keys: ['exportar', 'excel', 'csv', 'descargar'] },
    { action: 'print', keys: ['imprimir', 'print', 'pdf', 'etiqueta'] },
    { action: 'search', keys: ['buscar', 'filtrar', 'encontrar', 'consultar'] },
    { action: 'view', keys: ['ver', 'listar', 'mostrar'] }
  ];
  for (const entry of keywords) {
    for (const key of entry.keys) {
      if (text.includes(key)) return entry.action;
    }
  }
  if (helpData && helpData.help) {
    const helpKeys = Object.keys(helpData.help);
    for (const action of helpKeys) {
      if (text.includes(String(action))) return action;
    }
  }
  return null;
}

function getAiAllowedActions(permissionMap, moduleCode) {
  const actions = new Set();
  if (!moduleCode) return [];
  if (permissionMap && !isModuleAllowed(permissionMap, moduleCode)) return [];
  if (permissionMap && permissionMap.isAdmin) {
    ['view', 'create', 'edit', 'delete', 'export'].forEach((a) => actions.add(a));
  } else if (permissionMap && permissionMap.modules && permissionMap.modules[moduleCode]) {
    Object.keys(permissionMap.modules[moduleCode]).forEach((action) => actions.add(action));
  }
  if (actions.has('view')) actions.add('search');
  if (actions.has('export')) actions.add('print');
  return Array.from(actions);
}

function buildAiAnswer({ moduleCode, helpData, allowedActions, requestedAction }) {
  const moduleLabel = (helpData && helpData.module_name) || AI_MODULE_LABELS[moduleCode] || moduleCode || 'modulo';
  const description = helpData && helpData.description ? helpData.description : '';
  const actionLabel = requestedAction ? AI_ACTION_LABELS[requestedAction] || requestedAction : null;
  const allowedLabels = (allowedActions || [])
    .filter((action) => AI_ACTION_LABELS[action])
    .map((action) => AI_ACTION_LABELS[action]);

  if (requestedAction) {
    if (!allowedActions.includes(requestedAction)) {
      return `No tienes permiso para ${actionLabel || 'esa accion'} en ${moduleLabel}.`;
    }
    const helpText = helpData && helpData.help ? helpData.help[requestedAction] : null;
    const lines = [
      `Ayuda para ${actionLabel} en ${moduleLabel}.`,
      helpText || 'No tengo una guia especifica, pero puedo darte una orientacion general.',
      'Recuerda: solo puedo sugerir pasos permitidos para tu usuario.'
    ];
    if (allowedLabels.length) {
      lines.push(`Acciones disponibles para tu usuario: ${allowedLabels.join(', ')}.`);
    }
    return lines.join('\n');
  }

  const lines = [
    `Ayuda del modulo ${moduleLabel}.`,
    description || 'Puedo ayudarte con preguntas sobre este modulo del sistema.',
    'Si necesitas una accion especifica, dime que deseas hacer.'
  ];
  if (allowedLabels.length) {
    lines.push(`Acciones disponibles para tu usuario: ${allowedLabels.join(', ')}.`);
  }
  if (helpData && Array.isArray(helpData.faqs) && helpData.faqs.length) {
    const faq = helpData.faqs[0];
    if (faq && faq.q && faq.a) {
      lines.push(`FAQ: ${faq.q} - ${faq.a}`);
    }
  }
  return lines.join('\n');
}

function seedAiHelpModules() {
  const rows = [
    {
      module_code: 'packages',
      module_name: 'Paquetes',
      description: 'Gestiona el flujo de paquetes, estados, etiquetas y facturacion asociada.',
      actions: ['view', 'create', 'edit', 'delete', 'export', 'search', 'print'],
      faqs: [
        { q: 'Como cambio el estado de un paquete?', a: 'Desde el detalle del paquete usa la opcion de estado.' }
      ],
      help: {
        create: 'Usa Paquetes > Nuevo y completa remitente, destinatario, peso y datos del envio.',
        edit: 'En el detalle del paquete presiona Editar y guarda.',
        delete: 'Elimina solo si tienes permiso y el paquete no esta cerrado.',
        search: 'Filtra por estado, fecha, cliente o codigo interno.',
        export: 'Desde reportes de paquetes exporta el listado.',
        print: 'Exporta la etiqueta o el reporte para imprimir.'
      }
    },
    {
      module_code: 'users',
      module_name: 'Usuarios',
      description: 'Crea usuarios y asigna permisos por modulo.',
      actions: ['view', 'create', 'edit', 'delete', 'search'],
      faqs: [
        { q: 'Como asigno permisos?', a: 'En el usuario, usa la seccion de permisos por modulo.' }
      ],
      help: {
        create: 'Crea el usuario y luego asigna permisos segun su rol.',
        edit: 'Actualiza datos o permisos desde el detalle.',
        delete: 'Elimina usuarios solo si esta permitido.',
        search: 'Busca por usuario o rol.'
      }
    },
    {
      module_code: 'companies',
      module_name: 'Empresas',
      description: 'Administra empresas, datos fiscales y configuraciones generales.',
      actions: ['view', 'create', 'edit', 'delete', 'search'],
      faqs: [
        { q: 'Como creo una empresa?', a: 'Desde el panel master crea la empresa con sus datos principales.' }
      ],
      help: {
        create: 'Crea la empresa con nombre, usuario y datos fiscales.',
        edit: 'Actualiza datos generales y guarda.',
        delete: 'Elimina empresas solo si tienes permisos master.',
        search: 'Busca por nombre o usuario.'
      }
    },
    {
      module_code: 'inventory',
      module_name: 'Inventario',
      description: 'Gestiona productos, categorias, marcas y stock.',
      actions: ['view', 'create', 'edit', 'delete', 'export', 'search', 'print'],
      faqs: [
        { q: 'Como encuentro un producto?', a: 'Usa la busqueda o filtros por categoria y marca.' }
      ],
      help: {
        create: 'Ve a Inventario y registra nombre, SKU y precio.',
        edit: 'Abre el producto y edita los campos necesarios.',
        delete: 'Elimina productos solo si tienes permiso.',
        search: 'Busca por SKU, nombre o categoria.',
        export: 'Usa exportar para descargar el listado.',
        print: 'Exporta el listado para imprimir.'
      }
    },
    {
      module_code: 'manifests',
      module_name: 'Manifiestos',
      description: 'Gestiona manifiestos y sus piezas asociadas.',
      actions: ['view', 'create', 'edit', 'export', 'search', 'print'],
      faqs: [
        { q: 'Como cierro un manifiesto?', a: 'Desde el detalle usa la accion de cerrar.' }
      ],
      help: {
        create: 'Crea el manifiesto y agrega piezas o paquetes.',
        edit: 'Edita notas o items antes de cerrar.',
        search: 'Filtra por numero, fecha o estado.',
        export: 'Exporta el manifiesto en PDF o Excel.',
        print: 'Exporta el PDF para imprimir.'
      }
    },
    {
      module_code: 'airway_bills',
      module_name: 'Guias aereas',
      description: 'Gestiona guias aereas, vuelos y detalles de carga.',
      actions: ['view', 'create', 'edit', 'export', 'search', 'print'],
      faqs: [
        { q: 'Como emito una guia aerea?', a: 'Crea la guia, completa datos y emite desde el detalle.' }
      ],
      help: {
        create: 'Crea la guia aerea con datos de remitente, consignatario y vuelo.',
        edit: 'Edita campos mientras la guia esta en borrador.',
        search: 'Busca por numero de guia o fecha.',
        export: 'Exporta el PDF para compartir.',
        print: 'Imprime desde la vista previa PDF.'
      }
    }
  ];

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ai_help_modules
     (company_id, module_code, module_name, description, actions_json, faqs_json, help_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  rows.forEach((row) => {
    stmt.run(
      null,
      row.module_code,
      row.module_name,
      row.description,
      JSON.stringify(row.actions || []),
      JSON.stringify(row.faqs || []),
      JSON.stringify(row.help || {})
    );
  });

  stmt.finalize();
}

app.get('/ai/token', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  return res.json({ token: req.csrfToken() });
});

app.get('/ai/context', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  return res.json({
    permissions: req.session.permissionMap || null
  });
});

app.post('/ai/chat', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const question = String(req.body && req.body.question ? req.body.question : '').trim();
  if (!question) {
    return res.status(400).json({ error: 'Pregunta requerida.' });
  }

  const route = req.body && req.body.route ? String(req.body.route) : null;
  const moduleFromPath = resolveModuleByPath(route);
  const moduleCode = moduleFromPath || (req.body && req.body.module ? String(req.body.module) : null);
  const permissionMap = req.session.permissionMap || null;

  if (!moduleCode) {
    return res.json({
      answer: 'No pude identificar el modulo actual. Indica en que seccion estas trabajando.'
    });
  }

  if (!hasPermission(permissionMap, moduleCode, 'view')) {
    return res.json({
      answer: `No tienes permiso para ver el modulo ${moduleCode}.`
    });
  }

  const allowedActions = getAiAllowedActions(permissionMap, moduleCode);

  loadAiHelpModule(getCompanyId(req), moduleCode, (err, helpData) => {
    if (err) {
      console.error('[ai/chat] help load failed', err);
    }
    const requestedAction = detectAiAction(question, helpData);
    const answer = buildAiAnswer({
      moduleCode,
      helpData,
      allowedActions,
      requestedAction
    });
    return res.json({
      answer,
      module: moduleCode,
      route
    });
  });
});

function inventoryRedirectPath(req) {
  const category = req.query && req.query.category ? String(req.query.category) : '';
  if (category && category !== 'all') {
    return `/inventory?category=${encodeURIComponent(category)}`;
  }
  return '/inventory';
}

function resolveCategoryId(rawCategoryId, companyId, callback) {
  if (!rawCategoryId) return callback(null, null);
  const parsed = Number(rawCategoryId);
  if (!Number.isInteger(parsed) || parsed <= 0) return callback(null, null);
  db.get('SELECT id FROM categories WHERE id = ? AND company_id = ?', [parsed, companyId], (err, row) => {
    if (err || !row) return callback(null, null);
    return callback(null, row.id);
  });
}

function resolveBrandId(rawBrandId, companyId, callback) {
  if (!rawBrandId) return callback(null, null);
  const parsed = Number(rawBrandId);
  if (!Number.isInteger(parsed) || parsed <= 0) return callback(null, null);
  db.get('SELECT id FROM brands WHERE id = ? AND company_id = ?', [parsed, companyId], (err, row) => {
    if (err || !row) return callback(null, null);
    return callback(null, row.id);
  });
}

function normalizeCode(value) {
  const cleaned = (value || '')
    .toString()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return cleaned;
}

function buildManifestDetailData(manifestId, companyId, includeAvailable, callback) {
  db.get(
    `SELECT m.*, u.username AS created_by_name, u2.username AS closed_by_name
     FROM manifests m
     LEFT JOIN users u ON u.id = m.created_by
     LEFT JOIN users u2 ON u2.id = m.closed_by
     WHERE m.id = ? AND m.company_id = ?`,
    [manifestId, companyId],
    (err, manifest) => {
      if (err || !manifest) return callback(err || null, null);
      db.all(
        `SELECT * FROM manifest_pieces WHERE manifest_id = ? ORDER BY piece_number ASC`,
        [manifestId],
        (pieceErr, piecesRows) => {
          if (pieceErr) return callback(pieceErr);
          const pieces = piecesRows || [];
          db.all(
            `SELECT mpp.manifest_piece_id,
                    p.*,
                    c.name AS customer_name,
                    c.customer_code AS customer_code
             FROM manifest_piece_packages mpp
             JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
             JOIN packages p ON p.id = mpp.package_id
             LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = ?
             WHERE mp.manifest_id = ? AND p.company_id = ?
             ORDER BY mp.piece_number ASC, p.created_at DESC`,
            [companyId, manifestId, companyId],
            (pkgErr, packageRows) => {
              if (pkgErr) return callback(pkgErr);
              const rows = packageRows || [];
              const pieceMap = new Map();
              pieces.forEach((piece) => {
                pieceMap.set(piece.id, { ...piece, packages: [] });
              });
              rows.forEach((row) => {
                const piece = pieceMap.get(row.manifest_piece_id);
                if (!piece) return;
                piece.packages.push({
                  id: row.id,
                  internal_code: row.internal_code,
                  tracking_number: row.tracking_number,
                  customer_name: row.customer_name,
                  customer_code: row.customer_code,
                  status: row.status,
                  weight_lbs: row.weight_lbs
                });
              });
              const piecesWithPackages = Array.from(pieceMap.values());
              const summary = {
                totalPieces: piecesWithPackages.length,
                totalPackages: rows.length,
                totalWeight: rows.reduce((acc, item) => acc + (Number(item.weight_lbs) || 0), 0)
              };
              if (!includeAvailable) {
                return callback(null, {
                  manifest,
                  pieces: piecesWithPackages,
                  availablePackages: [],
                  summary
                });
              }
              db.all(
                `SELECT p.*, c.name AS customer_name, c.customer_code AS customer_code
                 FROM packages p
                 LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = ?
                 WHERE p.company_id = ?
                   AND p.id NOT IN (
                     SELECT mpp.package_id
                     FROM manifest_piece_packages mpp
                     JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
                     WHERE mp.manifest_id = ?
                   )
                 ORDER BY p.created_at DESC`,
                [companyId, companyId, manifestId],
                (availErr, availRows) => {
                  const availablePackages = availErr || !availRows ? [] : availRows;
                  return callback(null, {
                    manifest,
                    pieces: piecesWithPackages,
                    availablePackages,
                    summary
                  });
                }
              );
            }
          );
        }
      );
    }
  );
}

function codeFromName(name, length) {
  const cleaned = normalizeCode(name);
  if (!cleaned) return '';
  const target = Number.isInteger(length) && length > 0 ? length : 3;
  return cleaned.slice(0, target);
}

function itemBaseFromName(name) {
  const cleaned = normalizeCode(name);
  if (!cleaned) return '';
  if (cleaned.length <= 2) return cleaned;
  return cleaned.slice(0, 2);
}


function buildItemSku({ name, categoryId, brandId, companyId, codeMode, itemCode, excludeId }, callback) {
  fetchCategoryById(companyId, categoryId, (catErr, category) => {
    if (catErr) return callback(catErr);
    ensureCategoryCode(category, companyId, (catCodeErr, categoryCode) => {
      if (catCodeErr || !categoryCode) return callback(catCodeErr || new Error('Category code required'));
      fetchBrandById(companyId, brandId, (brandErr, brand) => {
        if (brandErr) return callback(brandErr);
        ensureBrandCode(brand, companyId, (brandCodeErr, brandCode) => {
          if (brandCodeErr || !brandCode) return callback(brandCodeErr || new Error('Brand code required'));
          const manual = codeMode === 'manual';
          const base = manual ? normalizeCode(itemCode) : itemBaseFromName(name);
          if (!base) return callback(new Error('Item code required'));
          if (manual) {
            const sku = `${categoryCode}-${brandCode}-${base}`;
            const params = [companyId, sku];
            let sql = 'SELECT id FROM items WHERE company_id = ? AND sku = ?';
            if (excludeId) {
              sql += ' AND id != ?';
              params.push(excludeId);
            }
            db.get(sql, params, (dupErr, row) => {
              if (dupErr) return callback(dupErr);
              if (row) return callback(new Error('SKU already exists'));
              return callback(null, { sku, itemCode: base });
            });
            return;
          }
          generateUniqueItemCode(companyId, categoryCode, brandCode, base, excludeId, (codeErr, finalCode) => {
            if (codeErr || !finalCode) return callback(codeErr || new Error('Item code required'));
            const sku = `${categoryCode}-${brandCode}-${finalCode}`;
            return callback(null, { sku, itemCode: finalCode });
          });
        });
      });
    });
  });
}
function generateUniqueSimpleCode(table, companyId, baseCode, excludeId, callback) {
  const base = normalizeCode(baseCode);
  if (!base) return callback(null, '');
  const params = [companyId];
  let sql = `SELECT code FROM ${table} WHERE company_id = ? AND code IS NOT NULL`;
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  db.all(sql, params, (err, rows) => {
    if (err) return callback(err);
    const used = new Set((rows || []).map((row) => normalizeCode(row.code)));
    if (!used.has(base)) return callback(null, base);
    let seq = 1;
    while (seq < 10000) {
      const candidate = `${base}${String(seq).padStart(2, '0')}`;
      if (!used.has(candidate)) return callback(null, candidate);
      seq += 1;
    }
    return callback(new Error('Unable to generate unique code'));
  });
}

function ensureCategoryCode(category, companyId, callback) {
  if (!category) return callback(new Error('Category not found'));
  const manual = Number(category.code_manual) === 1;
  if (manual) {
    const manualCode = normalizeCode(category.code);
    if (!manualCode) return callback(new Error('Category code required'));
    return callback(null, manualCode);
  }
  const existing = normalizeCode(category.code);
  if (existing) {
    return callback(null, existing);
  }
  const base = codeFromName(category.name, 3);
  generateUniqueSimpleCode('categories', companyId, base, category.id, (err, code) => {
    if (err) return callback(err);
    if (!code) return callback(new Error('Category code required'));
    db.run(
      'UPDATE categories SET code = ?, code_manual = 0 WHERE id = ? AND company_id = ?',
      [code, category.id, companyId]
    );
    return callback(null, code);
  });
}

function ensureBrandCode(brand, companyId, callback) {
  if (!brand) return callback(new Error('Brand not found'));
  const manual = Number(brand.code_manual) === 1;
  if (manual) {
    const manualCode = normalizeCode(brand.code);
    if (!manualCode) return callback(new Error('Brand code required'));
    return callback(null, manualCode);
  }
  const existing = normalizeCode(brand.code);
  if (existing) {
    return callback(null, existing);
  }
  const base = codeFromName(brand.name, 3);
  generateUniqueSimpleCode('brands', companyId, base, brand.id, (err, code) => {
    if (err) return callback(err);
    if (!code) return callback(new Error('Brand code required'));
    db.run(
      'UPDATE brands SET code = ?, code_manual = 0 WHERE id = ? AND company_id = ?',
      [code, brand.id, companyId]
    );
    return callback(null, code);
  });
}

function generateUniqueItemCode(companyId, categoryCode, brandCode, baseCode, excludeId, callback) {
  const base = normalizeCode(baseCode);
  if (!base) return callback(new Error('Item code required'));
  const like = `${categoryCode}-${brandCode}-${base}%`;
  const params = [companyId, like];
  let sql = 'SELECT sku FROM items WHERE company_id = ? AND sku LIKE ?';
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  db.all(sql, params, (err, rows) => {
    if (err) return callback(err);
    const usedCodes = new Set();
    (rows || []).forEach((row) => {
      const sku = (row.sku || '').toString();
      const parts = sku.split('-');
      const code = parts.length ? parts[parts.length - 1] : '';
      if (code) usedCodes.add(code);
    });
    if (!usedCodes.size) return callback(null, base);
    let max = 0;
    usedCodes.forEach((code) => {
      if (!code.startsWith(base)) return;
      const suffix = code.slice(base.length);
      if (!suffix) {
        max = Math.max(max, 0);
        return;
      }
      if (/^\d+$/.test(suffix)) {
        max = Math.max(max, Number(suffix));
      }
    });
    const next = max + 1;
    const padLen = next < 100 ? 2 : String(next).length;
    const candidate = `${base}${String(next).padStart(padLen, '0')}`;
    return callback(null, candidate);
  });
}

function fetchCategoryById(companyId, categoryId, callback) {
  db.get(
    'SELECT id, name, code, code_manual FROM categories WHERE id = ? AND company_id = ?',
    [categoryId, companyId],
    (err, row) => {
      if (err || !row) return callback(err || new Error('Category not found'));
      return callback(null, row);
    }
  );
}

function fetchBrandById(companyId, brandId, callback) {
  db.get(
    'SELECT id, name, code, code_manual FROM brands WHERE id = ? AND company_id = ?',
    [brandId, companyId],
    (err, row) => {
      if (err || !row) return callback(err || new Error('Brand not found'));
      return callback(null, row);
    }
  );
}

function buildItemSku(companyId, categoryId, brandId, itemName, codeMode, manualCode, excludeId, callback) {
  if (!categoryId || !brandId) return callback(new Error('Category and brand required'));
  fetchCategoryById(companyId, categoryId, (catErr, category) => {
    if (catErr || !category) return callback(catErr || new Error('Category not found'));
    ensureCategoryCode(category, companyId, (catCodeErr, categoryCode) => {
      if (catCodeErr) return callback(catCodeErr);
      fetchBrandById(companyId, brandId, (brandErr, brand) => {
        if (brandErr || !brand) return callback(brandErr || new Error('Brand not found'));
        ensureBrandCode(brand, companyId, (brandCodeErr, brandCode) => {
          if (brandCodeErr) return callback(brandCodeErr);
          const isManual = String(codeMode) === 'manual';
          const baseCode = isManual ? normalizeCode(manualCode) : itemBaseFromName(itemName);
          if (!baseCode) return callback(new Error('Item code required'));
          const finalize = (itemCode) => {
            const sku = `${categoryCode}-${brandCode}-${itemCode}`;
            const params = [sku, companyId];
            let sql = 'SELECT id FROM items WHERE sku = ? AND company_id = ?';
            if (excludeId) {
              sql += ' AND id != ?';
              params.push(excludeId);
            }
            db.get(sql, params, (skuErr, row) => {
              if (skuErr) return callback(skuErr);
              if (row) return callback(new Error('SKU already exists'));
              return callback(null, {
                sku,
                itemCode,
                categoryCode,
                brandCode
              });
            });
          };
          if (isManual) {
            return finalize(baseCode);
          }
          return generateUniqueItemCode(companyId, categoryCode, brandCode, baseCode, excludeId, (genErr, itemCode) => {
            if (genErr) return callback(genErr);
            return finalize(itemCode);
          });
        });
      });
    });
  });
}

function resolveCustomerId(rawCustomerId, companyId, callback) {
  if (!rawCustomerId) return callback(null, null);
  const parsed = Number(rawCustomerId);
  if (!Number.isInteger(parsed) || parsed <= 0) return callback(null, null);
  db.get('SELECT id FROM customers WHERE id = ? AND company_id = ?', [parsed, companyId], (err, row) => {
    if (err || !row) return callback(null, null);
    return callback(null, row.id);
  });
}

function getCustomerStatusById(customerId, companyId, callback) {
  const parsed = Number(customerId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return callback(null, { ok: false, reason: 'invalid' });
  }
  db.get(
    'SELECT id, is_voided FROM customers WHERE id = ? AND company_id = ?',
    [parsed, companyId],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(null, { ok: false, reason: 'missing' });
      if (Number(row.is_voided) === 1) return callback(null, { ok: false, reason: 'voided' });
      return callback(null, { ok: true, id: row.id });
    }
  );
}

function resolveConsignatarioId(rawConsignatarioId, companyId, customerId, callback) {
  if (!rawConsignatarioId) return callback(null, null);
  const parsed = Number(rawConsignatarioId);
  if (!Number.isInteger(parsed) || parsed <= 0) return callback(null, null);
  db.get(
    'SELECT id, customer_id FROM consignatarios WHERE id = ? AND company_id = ?',
    [parsed, companyId],
    (err, row) => {
      if (err || !row) return callback(null, null);
      if (customerId && row.customer_id && Number(row.customer_id) !== Number(customerId)) {
        return callback(null, null);
      }
      return callback(null, row.id);
    }
  );
}

function resolveConsignatarioWithCustomer(rawConsignatarioId, companyId, callback) {
  if (!rawConsignatarioId) return callback(null, null);
  const parsed = Number(rawConsignatarioId);
  if (!Number.isInteger(parsed) || parsed <= 0) return callback(null, null);
  db.get(
    'SELECT id, customer_id, full_address, municipality, department, phone FROM consignatarios WHERE id = ? AND company_id = ?',
    [parsed, companyId],
    (err, row) => {
      if (err || !row) return callback(null, null);
      return callback(null, {
        id: row.id,
        customer_id: row.customer_id,
        full_address: row.full_address,
        municipality: row.municipality,
        department: row.department,
        phone: row.phone
      });
    }
  );
}

function getOrCreateCategoryId(name, companyId, callback) {
  const trimmed = (name || '').toString().trim();
  if (!trimmed) return callback(null, null);
  db.get('SELECT id FROM categories WHERE name = ? AND company_id = ?', [trimmed, companyId], (err, row) => {
    if (err) return callback(err);
    if (row) return callback(null, row.id);
    const base = codeFromName(trimmed, 3);
    generateUniqueSimpleCode('categories', companyId, base, null, (codeErr, code) => {
      if (codeErr) return callback(codeErr);
      db.run(
        'INSERT INTO categories (name, code, code_manual, company_id) VALUES (?, ?, 0, ?)',
        [trimmed, code || null, companyId],
        function (insertErr) {
          if (insertErr) return callback(insertErr);
          return callback(null, this.lastID);
        }
      );
    });
  });
}

function getOrCreateBrandId(name, companyId, callback) {
  const trimmed = (name || '').toString().trim();
  if (!trimmed) return callback(null, null);
  db.get('SELECT id FROM brands WHERE name = ? AND company_id = ?', [trimmed, companyId], (err, row) => {
    if (err) return callback(err);
    if (row) return callback(null, row.id);
    const base = codeFromName(trimmed, 3);
    generateUniqueSimpleCode('brands', companyId, base, null, (codeErr, code) => {
      if (codeErr) return callback(codeErr);
      db.run(
        'INSERT INTO brands (name, code, code_manual, company_id) VALUES (?, ?, 0, ?)',
        [trimmed, code || null, companyId],
        function (insertErr) {
          if (insertErr) return callback(insertErr);
          return callback(null, this.lastID);
        }
      );
    });
  });
}

function renderInventory(req, res, error) {
  const selectedCategory = req.query.category ? String(req.query.category) : 'all';
  const companyId = getCompanyId(req);
  const companySettings = req.session ? req.session.company || {} : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const allowedCurrencies = parseCurrencyList(companySettings.allowed_currencies, baseCurrency);
  const requestedCurrency = String(req.body.currency || '').trim().toUpperCase();
  const currency = allowedCurrencies.includes(requestedCurrency) ? requestedCurrency : baseCurrency;
  const exchangeRate = currency === baseCurrency ? 1 : Number(req.body.exchange_rate || 0);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return renderInvoices(req, res, res.locals.t('errors.exchange_rate_invalid'));
  }

  db.all('SELECT id, name, code FROM categories WHERE company_id = ? ORDER BY name', [companyId], (catErr, categories) => {
    const safeCategories = catErr ? [] : categories;
    db.all('SELECT id, name, code FROM brands WHERE company_id = ? ORDER BY name', [companyId], (brandErr, brands) => {
      const safeBrands = brandErr ? [] : brands;
      const params = [companyId];
      let whereClause = 'WHERE items.company_id = ?';

      if (selectedCategory !== 'all' && /^[0-9]+$/.test(selectedCategory)) {
        whereClause += ' AND items.category_id = ?';
        params.push(Number(selectedCategory));
      }

      db.get(
        `SELECT SUM(qty * price) AS total
         FROM items
         ${whereClause}`,
        params,
        (totalErr, totalRow) => {
          const totalValue = !totalErr && totalRow && totalRow.total !== null ? totalRow.total : 0;

          const lowStockClause = whereClause
            ? `${whereClause} AND items.qty <= items.min_stock`
            : 'WHERE items.qty <= items.min_stock';

          db.get(
            `SELECT COUNT(*) AS count
             FROM items
             ${lowStockClause}`,
            params,
            (lowErr, lowRow) => {
              const lowStockCount = !lowErr && lowRow ? lowRow.count : 0;

              const itemParams = [companyId, companyId, ...params];
              db.all(
                `SELECT items.*, categories.name AS category_name, brands.name AS brand_name
                 FROM items
                 LEFT JOIN categories ON items.category_id = categories.id AND categories.company_id = ?
                 LEFT JOIN brands ON items.brand_id = brands.id AND brands.company_id = ?
                 ${whereClause}
                 ORDER BY items.created_at DESC`,
                itemParams,
                (err, rows) => {
                  const items = err ? [] : rows;
                  res.render('inventory', {
                    items,
                    categories: safeCategories,
                    brands: safeBrands,
                    selectedCategory,
                    totalValue,
                    lowStockCount,
                    error: error || null
                  });
                }
              );
            }
          );
        }
      );
    });
  });
}

function renderCategories(req, res, error) {
  const companyId = getCompanyId(req);
  const companySettings = req.session ? req.session.company || {} : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const allowedCurrencies = parseCurrencyList(companySettings.allowed_currencies, baseCurrency);
  const requestedCurrency = String(req.body.currency || '').trim().toUpperCase();
  const currency = allowedCurrencies.includes(requestedCurrency) ? requestedCurrency : baseCurrency;
  const exchangeRate = currency === baseCurrency ? 1 : Number(req.body.exchange_rate || 0);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return renderInvoices(req, res, res.locals.t('errors.exchange_rate_invalid'));
  }
  db.all(
    'SELECT id, name, code, code_manual FROM categories WHERE company_id = ? ORDER BY name',
    [companyId],
    (err, rows) => {
      const categories = err ? [] : rows;
      res.render('categories', {
        categories,
        error: error || null
      });
    }
  );
}

function renderBrands(req, res, error) {
  const companyId = getCompanyId(req);
  const companySettings = req.session ? req.session.company || {} : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const allowedCurrencies = parseCurrencyList(companySettings.allowed_currencies, baseCurrency);
  const requestedCurrency = String(req.body.currency || '').trim().toUpperCase();
  const currency = allowedCurrencies.includes(requestedCurrency) ? requestedCurrency : baseCurrency;
  const exchangeRate = currency === baseCurrency ? 1 : Number(req.body.exchange_rate || 0);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return renderInvoices(req, res, res.locals.t('errors.exchange_rate_invalid'));
  }
  db.all(
    'SELECT id, name, code, code_manual FROM brands WHERE company_id = ? ORDER BY name',
    [companyId],
    (err, rows) => {
      const brands = err ? [] : rows;
      res.render('brands', {
        brands,
        error: error || null
      });
    }
  );
}

function renderUsers(req, res, error, createdUser) {
  const companyId = getCompanyId(req);
  const companySettings = req.session ? req.session.company || {} : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const allowedCurrencies = parseCurrencyList(companySettings.allowed_currencies, baseCurrency);
  const requestedCurrency = String(req.body.currency || '').trim().toUpperCase();
  const currency = allowedCurrencies.includes(requestedCurrency) ? requestedCurrency : baseCurrency;
  const exchangeRate = currency === baseCurrency ? 1 : Number(req.body.exchange_rate || 0);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return renderInvoices(req, res, res.locals.t('errors.exchange_rate_invalid'));
  }
  db.all(
    'SELECT id, username, role, is_active, created_at FROM users WHERE company_id = ? ORDER BY created_at DESC',
    [companyId],
    (err, rows) => {
    const users = err ? [] : rows;
    db.all(
      'SELECT id, code, name FROM permission_modules WHERE is_active = 1 ORDER BY name',
      (modErr, modules) => {
        const safeModules = modErr ? [] : modules;
        db.all(
          `
          SELECT ma.module_id, pa.id AS action_id, pa.code, pa.name
          FROM module_actions ma
          JOIN permission_actions pa ON pa.id = ma.action_id AND pa.is_active = 1
          ORDER BY pa.name
          `,
          (actErr, actions) => {
            const safeActions = actErr ? [] : actions;
            const moduleMap = new Map();
            safeModules.forEach((m) => {
              moduleMap.set(m.id, { id: m.id, code: m.code, name: m.name, actions: [] });
            });
            safeActions.forEach((a) => {
              if (!moduleMap.has(a.module_id)) return;
              moduleMap.get(a.module_id).actions.push({
                id: a.action_id,
                code: a.code,
                name: a.name
              });
            });
            const modulesWithActions = Array.from(moduleMap.values());
            db.all(
              'SELECT user_id, module_id, action_id FROM user_permissions WHERE company_id = ?',
              [companyId],
              (permErr, perms) => {
                const map = {};
                (permErr ? [] : perms).forEach((p) => {
                  const key = String(p.user_id);
                  if (!map[key]) map[key] = new Set();
                  map[key].add(`${p.module_id}:${p.action_id}`);
                });
                res.render('users', {
                  users,
                  error: error || null,
                  modules: modulesWithActions,
                  userPermissionsMap: map,
                  createdUser: createdUser || null,
                  companyLabel: resolveCompanyLabel(req, res)
                });
              }
            );
          }
        );
      }
    );
    }
  );
}

function resolveCompanyLabel(req, res) {
  const company = req.session && req.session.company ? req.session.company : null;
  const fallbackLabel = res.locals.t('users.company_default');
  return company
    ? company.username || company.name || (company.id ? `${fallbackLabel} ${company.id}` : fallbackLabel)
    : fallbackLabel;
}

function buildCustomerListQuery(companyId, filters, options = {}) {
  const nameExpr = "TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))";
  const displayNameExpr = `CASE WHEN ${nameExpr} <> '' THEN ${nameExpr} ELSE COALESCE(c.name, '') END`;
  const voidedFlag = options.voided === 1 ? 1 : 0;
  const params = [companyId, voidedFlag];
  let whereClause = 'WHERE c.company_id = ? AND c.is_voided = ?';

  if (filters.name) {
    const like = `%${filters.name}%`;
    whereClause += ` AND (${displayNameExpr} LIKE ? OR c.name LIKE ? OR c.document_number LIKE ?)`;
    params.push(like, like, like);
  }
  if (filters.document_number) {
    whereClause += ' AND c.document_number LIKE ?';
    params.push(`%${filters.document_number}%`);
  }
  if (filters.customer_code) {
    whereClause += ' AND c.customer_code LIKE ?';
    params.push(`%${filters.customer_code}%`);
  }
  if (filters.advisor) {
    whereClause += ' AND c.advisor = ?';
    params.push(filters.advisor);
  }
  if (filters.payment_method) {
    whereClause += ' AND c.payment_method = ?';
    params.push(filters.payment_method);
  }
  if (filters.communication_type) {
    whereClause += ' AND c.communication_type = ?';
    params.push(filters.communication_type);
  }

  const query = `
    SELECT c.id, c.customer_code, c.portal_code, c.document_type, c.document_number,
           ${displayNameExpr} AS name,
           c.first_name, c.last_name, c.phone, c.email, c.mobile, c.advisor,
           c.payment_method, c.communication_type, c.country, c.department, c.municipality,
           c.zone, c.address, c.full_address, c.house_number, c.street_number, c.notes,
           c.created_at, c.is_voided, c.voided_at, c.voided_by,
           COUNT(cons.id) AS consignatarios_count
    FROM customers c
    LEFT JOIN consignatarios cons ON cons.customer_id = c.id AND cons.company_id = c.company_id
    ${whereClause}
    GROUP BY c.id
    ORDER BY LOWER(${displayNameExpr}) ASC, c.id DESC`;

  return { query, params };
}

function renderCustomers(req, res, error, options = {}) {
  const companyId = getCompanyId(req);
  const companySettings = req.session ? req.session.company || {} : {};
  const baseCurrency = String(companySettings.base_currency || companySettings.currency || 'GTQ').toUpperCase();
  const allowedCurrencies = parseCurrencyList(companySettings.allowed_currencies, baseCurrency);
  const requestedCurrency = String(req.body.currency || '').trim().toUpperCase();
  const currency = allowedCurrencies.includes(requestedCurrency) ? requestedCurrency : baseCurrency;
  const exchangeRate = currency === baseCurrency ? 1 : Number(req.body.exchange_rate || 0);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return renderInvoices(req, res, res.locals.t('errors.exchange_rate_invalid'));
  }
  const searchName = normalizeString(req.query.name);
  const searchDocument = normalizeString(req.query.document_number);
  const searchCustomerCode = normalizeString(req.query.customer_code);
  const filterAdvisor = normalizeString(req.query.advisor);
  const filterPayment = normalizeString(req.query.payment_method);
  const filterCommunication = normalizeString(req.query.communication_type);
  const pkgConsignatario = normalizeString(req.query.pkg_consignatario);
  const pkgStatus = normalizeString(req.query.pkg_status);
  const pkgAction = normalizeString(req.query.pkg_action);
  const pkgCode = normalizeString(req.query.pkg_code);

  const filters = {
    name: searchName,
    document_number: searchDocument,
    customer_code: searchCustomerCode,
    advisor: filterAdvisor,
    payment_method: filterPayment,
    communication_type: filterCommunication
  };
  const packageFilters = {
    consignatario: pkgConsignatario,
    status: pkgStatus,
    action: pkgAction,
    code: pkgCode
  };
  const allowedTabs = new Set(['list', 'import', 'create', 'packages', 'voided']);
  const requestedTab = normalizeString(options.activeTab);
  const { query, params } = buildCustomerListQuery(companyId, filters, { voided: 0 });
  const { query: voidedQuery, params: voidedParams } = buildCustomerListQuery(companyId, filters, { voided: 1 });
  const canViewVoided = res.locals.can ? res.locals.can('customers', 'view_voided') : false;
  const activeCustomersTab =
    requestedTab === 'voided' && !canViewVoided
      ? 'list'
      : (allowedTabs.has(requestedTab) ? requestedTab : 'list');

  db.all(
    query,
    params,
    (err, rows) => {
      const customers = err ? [] : rows;
      const loadVoided = (cb) => {
        if (!canViewVoided) return cb(null, []);
        return db.all(voidedQuery, voidedParams, (voidErr, voidedRows) => {
          return cb(voidErr || null, voidErr ? [] : voidedRows || []);
        });
      };
      loadVoided((voidErr, voidedCustomers) => {
        db.all(
          `SELECT DISTINCT advisor
           FROM customers
           WHERE company_id = ? AND advisor IS NOT NULL AND advisor <> '' AND is_voided = 0
           ORDER BY advisor`,
          [companyId],
          (advErr, advisorRows) => {
            const advisors = advErr ? [] : advisorRows.map((row) => row.advisor);
            db.all(
              'SELECT id, name FROM consignatarios WHERE company_id = ? ORDER BY name',
              [companyId],
              (consErr, consignatarios) => {
                fetchPackagesList(companyId, packageFilters, (pkgErr, packages) => {
                  const params = new URLSearchParams();
                  if (searchName) params.set('name', searchName);
                  if (searchDocument) params.set('document_number', searchDocument);
                  if (searchCustomerCode) params.set('customer_code', searchCustomerCode);
                  if (filterAdvisor) params.set('advisor', filterAdvisor);
                  if (filterPayment) params.set('payment_method', filterPayment);
                  if (filterCommunication) params.set('communication_type', filterCommunication);
                  const exportUrl = params.toString() ? `/customers/export?${params.toString()}` : '/customers/export';
                  res.render('customers', {
                    activeCustomersTab,
                    customers,
                    voidedCustomers: voidErr ? [] : voidedCustomers || [],
                    canViewVoided,
                    exportUrl,
                    error: error || null,
                    flash: res.locals.flash,
                    advisors,
                    filters,
                    paymentMethods: PAYMENT_METHODS,
                    communicationTypes: COMMUNICATION_TYPES,
                    documentTypes: CUSTOMER_DOCUMENT_TYPES,
                    packages: pkgErr ? [] : packages || [],
                    packageFilters,
                    packageStatuses: PACKAGE_STATUSES,
                    consignatarios: consErr ? [] : consignatarios || []
                  });
                });
              }
            );
          }
        );
      });
    }
  );
}

function resolveConsignatariosSort(req) {
  const key = normalizeString(req.query.sort);
  const dirRaw = normalizeString(req.query.dir);
  const dir = dirRaw === 'asc' ? 'ASC' : 'DESC';
  const columns = {
    name: 'LOWER(consignatarios.name)',
    document: 'LOWER(consignatarios.document_number)',
    customer: 'LOWER(customers.name)',
    phone: 'LOWER(consignatarios.phone)',
    created: 'consignatarios.created_at'
  };
  const safeKey = columns[key] ? key : 'created';
  return { key: safeKey, dir, orderBy: `${columns[safeKey]} ${dir}` };
}

function buildConsignatariosListQuery(companyId, filters, sort) {
  const params = [companyId, companyId];
  let whereClause = 'WHERE consignatarios.company_id = ?';

  if (filters.name) {
    whereClause += ' AND consignatarios.name LIKE ?';
    params.push(`%${filters.name}%`);
  }
  if (filters.document_number) {
    whereClause += ' AND consignatarios.document_number LIKE ?';
    params.push(`%${filters.document_number}%`);
  }
  if (Number.isInteger(filters.customer_id) && filters.customer_id > 0) {
    whereClause += ' AND consignatarios.customer_id = ?';
    params.push(filters.customer_id);
  }

  const orderBy = sort && sort.orderBy ? sort.orderBy : 'consignatarios.created_at DESC';
  const query = `SELECT consignatarios.*, customers.name AS customer_name, customers.customer_code AS customer_code
     FROM consignatarios
     LEFT JOIN customers ON consignatarios.customer_id = customers.id AND customers.company_id = ?
     ${whereClause}
     ORDER BY ${orderBy}`;

  return { query, params };
}

function renderConsignatarios(req, res, error, options = {}) {
  const companyId = getCompanyId(req);
  const searchName = normalizeString(req.query.name);
  const searchDocument = normalizeString(req.query.document_number);
  const filterCustomerId = Number(req.query.customer_id || 0);
  const sort = resolveConsignatariosSort(req);
  const allowedTabs = new Set(['list', 'filters', 'manage']);
  const requestedTab = normalizeString(options.activeTab);
  const activeConsignatariosTab = allowedTabs.has(requestedTab) ? requestedTab : 'list';

  const filters = {
    name: searchName,
    document_number: searchDocument,
    customer_id: filterCustomerId
  };
  const { query, params } = buildConsignatariosListQuery(companyId, filters, sort);

  db.all(
    query,
    params,
    (err, consignatarios) => {
      db.all(
        'SELECT id, name, customer_code FROM customers WHERE company_id = ? AND is_voided = 0 ORDER BY name',
        [companyId],
        (custErr, customers) => {
          const params = new URLSearchParams();
          if (searchName) params.set('name', searchName);
          if (searchDocument) params.set('document_number', searchDocument);
          if (filterCustomerId > 0) params.set('customer_id', String(filterCustomerId));
          if (sort && sort.key) params.set('sort', sort.key);
          if (sort && sort.dir) params.set('dir', sort.dir.toLowerCase());
          const exportUrl = params.toString() ? `/consignatarios/export?${params.toString()}` : '/consignatarios/export';
          const baseParams = new URLSearchParams();
          if (searchName) baseParams.set('name', searchName);
          if (searchDocument) baseParams.set('document_number', searchDocument);
          if (filterCustomerId > 0) baseParams.set('customer_id', String(filterCustomerId));
          res.render('consignatarios', {
            activeConsignatariosTab,
            consignatarios: err ? [] : consignatarios || [],
            customers: custErr ? [] : customers || [],
            exportUrl,
            error: error || null,
            flash: res.locals.flash,
            sort,
            sortBaseQuery: baseParams.toString(),
            filters: {
              name: searchName,
              document_number: searchDocument,
              customer_id: filterCustomerId > 0 ? String(filterCustomerId) : ''
            },
            documentTypes: CUSTOMER_DOCUMENT_TYPES,
            countries: COMPANY_COUNTRIES
          });
        }
      );
    }
  );
}

function renderInvoices(req, res, error) {
  const companyId = getCompanyId(req);
  db.get(
    'SELECT id, base_currency, allowed_currencies, tax_rate, tax_name, currency FROM companies WHERE id = ?',
    [companyId],
    (compErr, company) => {
      const baseCurrency = String((company && (company.base_currency || company.currency)) || 'GTQ').toUpperCase();
      const allowedCurrencies = parseCurrencyList(company && company.allowed_currencies, baseCurrency);
      const taxRate = Number.isFinite(Number(company && company.tax_rate)) ? Number(company.tax_rate) : null;
      const taxName = company && company.tax_name ? String(company.tax_name) : null;

      db.all('SELECT id, name, customer_code FROM customers WHERE company_id = ? AND is_voided = 0 ORDER BY name', [companyId], (custErr, customers) => {
        const safeCustomers = custErr ? [] : customers;
        db.all('SELECT id, name, price FROM items WHERE company_id = ? ORDER BY name', [companyId], (itemErr, items) => {
          const safeItems = itemErr ? [] : items;
          db.all(
            `SELECT invoices.id, invoices.subtotal, invoices.tax_rate, invoices.tax_amount,
                    invoices.discount_type, invoices.discount_value, invoices.discount_amount,
                    invoices.total, invoices.created_at, invoices.currency, invoices.exchange_rate,
                    invoices.subtotal_base, invoices.tax_amount_base, invoices.discount_amount_base, invoices.total_base,
                    customers.name AS customer_name,
                    customers.customer_code AS customer_code
             FROM invoices
             LEFT JOIN customers ON invoices.customer_id = customers.id AND customers.company_id = ?
             WHERE invoices.company_id = ?
             ORDER BY invoices.created_at DESC`,
            [companyId, companyId],
            (invErr, invoices) => {
              res.render('invoices', {
                customers: safeCustomers,
                items: safeItems,
                invoices: invErr ? [] : invoices,
                error: error || null,
                companySettings: {
                  baseCurrency,
                  allowedCurrencies,
                  taxRate,
                  taxName
                }
              });
            }
          );
        });
      });
    }
  );
}

function getCompanyBrandById(companyId, callback) {
  if (!companyId) return callback(null);
  getCompanySettings(companyId, (company) => {
    if (!company) return callback(null);
    const appearance = extractCompanyAppearance(company);
    return callback({
      id: company.id,
      name: company.name,
      logo: buildFileUrl(appearance.logoPath || null),
      logo_path: appearance.logoPath || null,
      primary_color: appearance.primaryColor,
      secondary_color: appearance.secondaryColor,
      background_color: appearance.backgroundColor,
      title_color: appearance.titleColor,
      text_color: appearance.textColor,
      font_family: appearance.fontFamily,
      logo_size: appearance.logoSize,
      icon_size: appearance.iconSize,
      icon_frame: appearance.iconFrame,
      theme_style: buildCompanyThemeStyle(appearance)
    });
  });
}

function getPackageLabelLayout(companyId, callback) {
  if (!companyId) return callback(null);
  db.get(
    'SELECT layout_json FROM package_label_layouts WHERE company_id = ? LIMIT 1',
    [companyId],
    (err, row) => {
      if (err || !row || !row.layout_json) return callback(null);
      try {
        const parsed = JSON.parse(row.layout_json);
        return callback(parsed);
      } catch (parseErr) {
        return callback(null);
      }
    }
  );
}

function savePackageLabelLayout(companyId, layout, callback) {
  if (!companyId) return callback(new Error('missing company'));
  const payload = JSON.stringify(layout || {});
  db.run(
    `INSERT INTO package_label_layouts (company_id, layout_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(company_id) DO UPDATE SET
       layout_json = excluded.layout_json,
       updated_at = CURRENT_TIMESTAMP`,
    [companyId, payload],
    (err) => callback(err)
  );
}

function fetchDashboardStats(companyId, callback) {
  const stats = {
    packageCount: 0,
    itemCount: 0,
    lowStock: 0,
    packageReceivedToday: 0,
    packageInTransit: 0,
    packageInCustoms: 0,
    packageReadyDelivery: 0
  };
  if (!companyId) return callback(stats);

  let pending = 3;
  const finish = () => {
    pending -= 1;
    if (pending <= 0) return callback(stats);
  };

  db.get('SELECT COUNT(*) AS count FROM items WHERE company_id = ?', [companyId], (err, row) => {
    stats.itemCount = !err && row ? Number(row.count || 0) : 0;
    finish();
  });

  db.get(
    'SELECT COUNT(*) AS count FROM items WHERE company_id = ? AND qty <= min_stock',
    [companyId],
    (err, row) => {
      stats.lowStock = !err && row ? Number(row.count || 0) : 0;
      finish();
    }
  );

  findPackagesTable((table) => {
    if (!table) {
      finish();
      return;
    }
    const inTransit = ['Cargado a vuelo', 'En trÃ¡nsito'];
    const inCustoms = ['En aduana de destino', 'En proceso de aduana'];
    const readyDelivery = ['Liberado', 'En entrega'];
    const sql = `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN date(received_at) = date('now','localtime') THEN 1 ELSE 0 END) AS received_today,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS in_transit,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS in_customs,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS ready_delivery
      FROM ${table}
      WHERE company_id = ?`;
    db.get(sql, [...inTransit, ...inCustoms, ...readyDelivery, companyId], (err, row) => {
      if (!err && row) {
        stats.packageCount = Number(row.total || 0);
        stats.packageReceivedToday = Number(row.received_today || 0);
        stats.packageInTransit = Number(row.in_transit || 0);
        stats.packageInCustoms = Number(row.in_customs || 0);
        stats.packageReadyDelivery = Number(row.ready_delivery || 0);
      }
      finish();
    });
  });
}

function daysSince(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff) || diff < 0) return 0;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function computePackageStats(companyId, callback) {
  const stats = {
    total: 0,
    receivedToday: 0,
    pendingInvoice: 0,
    inTransit: 0,
    inCustoms: 0,
    readyDelivery: 0,
    delivered: 0
  };
  if (!companyId) return callback(stats);
  findPackagesTable((table) => {
    if (!table) return callback(stats);
    const inTransit = ['Cargado a vuelo', 'En trÃ¡nsito'];
    const inCustoms = ['En aduana de destino', 'En proceso de aduana'];
    const readyDelivery = ['Liberado', 'En entrega'];
    const sql = `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN date(received_at) = date('now','localtime') THEN 1 ELSE 0 END) AS received_today,
      SUM(CASE WHEN invoice_status IS NULL OR invoice_status <> 'uploaded' THEN 1 ELSE 0 END) AS pending_invoice,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS in_transit,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS in_customs,
      SUM(CASE WHEN status IN (?, ?) THEN 1 ELSE 0 END) AS ready_delivery,
      SUM(CASE WHEN status = 'Entregado' THEN 1 ELSE 0 END) AS delivered
      FROM ${table}
      WHERE company_id = ?`;
    db.get(sql, [...inTransit, ...inCustoms, ...readyDelivery, companyId], (err, row) => {
      if (!err && row) {
        stats.total = Number(row.total || 0);
        stats.receivedToday = Number(row.received_today || 0);
        stats.pendingInvoice = Number(row.pending_invoice || 0);
        stats.inTransit = Number(row.in_transit || 0);
        stats.inCustoms = Number(row.in_customs || 0);
        stats.readyDelivery = Number(row.ready_delivery || 0);
        stats.delivered = Number(row.delivered || 0);
      }
      return callback(stats);
    });
  });
}

function computePackageStatusCounts(companyId, callback) {
  findPackagesTable((table) => {
    if (!table) return callback([]);
    db.all(
      `SELECT status, COUNT(*) AS count
       FROM ${table}
       WHERE company_id = ?
       GROUP BY status`,
      [companyId],
      (err, rows) => callback(err ? [] : rows || [])
    );
  });
}

function fetchPackagesList(companyId, filters, callback) {
  findPackagesTable((table) => {
    if (!table) return callback(null, []);
    const params = [companyId];
    let whereClause = 'WHERE p.company_id = ?';

    if (filters && filters.q) {
      whereClause += ' AND (p.internal_code LIKE ? OR p.tracking_number LIKE ? OR p.description LIKE ?)';
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    if (filters && filters.status) {
      whereClause += ' AND p.status = ?';
      params.push(filters.status);
    }
    if (filters && filters.action) {
      whereClause += ' AND p.invoice_status = ?';
      params.push(filters.action);
    }
    if (filters && filters.customer) {
      whereClause += ' AND p.customer_id = ?';
      params.push(filters.customer);
    }
    if (filters && filters.consignatario) {
      whereClause += ' AND p.consignatario_id = ?';
      params.push(filters.consignatario);
    }
    if (filters && filters.code) {
      whereClause += ' AND (p.internal_code LIKE ? OR p.tracking_number LIKE ?)';
      const likeCode = `%${filters.code}%`;
      params.push(likeCode, likeCode);
    }
    if (filters && filters.carrier) {
      whereClause += ' AND p.carrier LIKE ?';
      params.push(`%${filters.carrier}%`);
    }
    if (filters && filters.received_date) {
      whereClause += " AND date(p.received_at) = date(?)";
      params.push(filters.received_date);
    }

    const sql = `SELECT p.*,
            c.name AS customer_name,
            c.customer_code AS customer_code,
            c.phone AS customer_phone,
            c.email AS customer_email,
            cons.name AS consignatario_name,
            cons.full_address AS consignatario_address,
            cons.municipality AS consignatario_municipality,
            cons.department AS consignatario_department,
            cons.phone AS consignatario_phone,
            (SELECT MAX(COALESCE(changed_at, created_at)) FROM package_status_history WHERE package_id = p.id) AS last_status_at
     FROM ${table} p
     LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
     LEFT JOIN consignatarios cons ON cons.id = p.consignatario_id AND cons.company_id = p.company_id
     ${whereClause}
     ORDER BY p.created_at DESC`;
    db.all(sql, params, (err, rows) => {
      if (err) return callback(err, []);
      const mapped = (rows || []).map((pkg) => {
        const lastStatusAt = pkg.last_status_at || pkg.received_at;
        return {
          ...pkg,
          days_in_status: daysSince(lastStatusAt),
          days_since_received: daysSince(pkg.received_at)
        };
      });
      return callback(null, mapped);
    });
  });
}

function fetchPendingInvoicePackages(companyId, callback) {
  findPackagesTable((table) => {
    if (!table) return callback(new Error('packages_table_missing'), []);
    db.all(
      `SELECT p.*,
              c.name AS customer_name,
              c.customer_code AS customer_code,
              c.phone AS customer_phone,
              c.email AS customer_email,
              cons.name AS consignatario_name,
              cons.phone AS consignatario_phone
       FROM ${table} p
       LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
       LEFT JOIN consignatarios cons ON cons.id = p.consignatario_id AND cons.company_id = p.company_id
       WHERE p.company_id = ?
         AND (p.invoice_status IS NULL OR p.invoice_status <> 'uploaded' OR p.invoice_file IS NULL)
       ORDER BY COALESCE(p.received_at, p.created_at) DESC`,
      [companyId],
      (err, rows) => {
        if (err || !rows) return callback(err || null, []);
        const mapped = (rows || []).map((pkg) => ({
          ...pkg,
          days_since_received: daysSince(pkg.received_at)
        }));
        return callback(null, mapped);
      }
    );
  });
}

function fetchPackageDetail(companyId, packageId, callback) {
  findPackagesTable((table) => {
    if (!table) return callback(new Error('packages_table_missing'));
    db.get(
      `SELECT p.*,
              c.name AS customer_name,
              c.customer_code AS customer_code,
              c.phone AS customer_phone,
              c.email AS customer_email,
              c.full_address AS customer_address,
              cons.name AS consignatario_name,
              cons.full_address AS consignatario_address,
              cons.municipality AS consignatario_municipality,
              cons.department AS consignatario_department,
              cons.phone AS consignatario_phone
       FROM ${table} p
       LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
       LEFT JOIN consignatarios cons ON cons.id = p.consignatario_id AND cons.company_id = p.company_id
       WHERE p.id = ? AND p.company_id = ?`,
      [packageId, companyId],
      (err, row) => {
        if (err || !row) return callback(err || new Error('package_not_found'));
        return callback(null, row);
      }
    );
  });
}

function fetchPackageHistory(packageId, callback) {
  db.all(
    `SELECT psh.*,
            u.username AS changed_by_name,
            COALESCE(psh.new_status, psh.status) AS display_status,
            COALESCE(psh.changed_at, psh.created_at) AS changed_at
     FROM package_status_history psh
     LEFT JOIN users u ON u.id = psh.changed_by
     WHERE psh.package_id = ?
     ORDER BY COALESCE(psh.changed_at, psh.created_at) ASC`,
    [packageId],
    (err, rows) => callback(err ? [] : rows || [])
  );
}

function fetchPackageComments(packageId, callback) {
  db.all(
    `SELECT pc.*, u.username AS created_by_name
     FROM package_comments pc
     LEFT JOIN users u ON u.id = pc.created_by
     WHERE pc.package_id = ?
     ORDER BY pc.created_at DESC`,
    [packageId],
    (err, rows) => callback(err ? [] : rows || [])
  );
}

function updatePackageStatusWithHistory(companyId, packageId, newStatus, changedBy, notes, callback) {
  if (!Number.isInteger(packageId) || packageId <= 0) return callback && callback(new Error('invalid_package'));
  if (!Number.isInteger(companyId) || companyId <= 0) return callback && callback(new Error('invalid_company'));
  if (!PACKAGE_STATUSES.includes(newStatus)) return callback && callback(new Error('invalid_status'));
  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return callback && callback(pkgErr || new Error('package_not_found'));
    if (pkg.status === newStatus) return callback && callback(null, false);
    findPackagesTable((table) => {
      if (!table) return callback && callback(new Error('packages_table_missing'));
      db.run(
        `UPDATE ${table} SET status = ? WHERE id = ? AND company_id = ?`,
        [newStatus, packageId, companyId],
        () => {
          db.run(
            `INSERT INTO package_status_history
             (package_id, status, old_status, new_status, changed_by, notes, company_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              packageId,
              newStatus,
              pkg.status,
              newStatus,
              changedBy || null,
              notes || null,
              companyId
            ],
            () => callback && callback(null, true)
          );
        }
      );
    });
  });
}

function insertPackagePhotos(packageId, companyId, files, callback) {
  if (!files || files.length === 0) return callback();
  let remaining = files.length;
  files.forEach((file) => {
    db.run(
      'INSERT INTO package_photos (package_id, file_path, company_id) VALUES (?, ?, ?)',
      [packageId, file.path, companyId],
      () => {
        remaining -= 1;
        if (remaining <= 0) callback();
      }
    );
  });
}

function buildPackageLabelData(pkg) {
  return {
    delivery_address: pkg.delivery_address || pkg.consignatario_address || null,
    delivery_municipality: pkg.delivery_municipality || pkg.consignatario_municipality || null,
    delivery_department: pkg.delivery_department || pkg.consignatario_department || null,
    delivery_phone: pkg.delivery_phone || pkg.consignatario_phone || null,
    store_name: pkg.store_name || null,
    description: pkg.description || null
  };
}

function generateBarcodeDataUrl(text, callback) {
  const safeText = normalizeString(text);
  if (!safeText) return callback(null, null);
  bwipjs.toBuffer(
    {
      bcid: 'code128',
      text: safeText,
      scale: 2,
      height: 12,
      includetext: false
    },
    (err, png) => {
      if (err || !png) return callback(null, null);
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      return callback(null, dataUrl);
    }
  );
}

function generateQrDataUrl(text, callback) {
  const safeText = normalizeString(text);
  if (!safeText) return callback(null, null);
  QRCode.toDataURL(safeText, { margin: 1, width: 220 }, (err, url) => {
    if (err) return callback(null, null);
    return callback(null, url);
  });
}

function parseAwbItemsFromBody(body) {
  const fields = [
    'item_pieces',
    'item_gross_weight',
    'item_dimensions',
    'item_goods_description',
    'item_rate_class',
    'item_chargeable_weight',
    'item_rate',
    'item_total'
  ];
  const arrays = {};
  let maxLen = 0;
  fields.forEach((field) => {
    const raw = body[field] || [];
    const list = Array.isArray(raw) ? raw : [raw];
    arrays[field] = list;
    if (list.length > maxLen) maxLen = list.length;
  });
  const items = [];
  for (let i = 0; i < maxLen; i += 1) {
    const pieces = arrays.item_pieces[i];
    const grossWeight = arrays.item_gross_weight[i];
    const dimensions = arrays.item_dimensions[i];
    const goodsDescription = arrays.item_goods_description[i];
    const rateClass = arrays.item_rate_class[i];
    const chargeableWeight = arrays.item_chargeable_weight[i];
    const rate = arrays.item_rate[i];
    const total = arrays.item_total[i];

    const hasData =
      normalizeString(pieces) ||
      normalizeString(grossWeight) ||
      normalizeString(dimensions) ||
      normalizeString(goodsDescription) ||
      normalizeString(rateClass) ||
      normalizeString(chargeableWeight) ||
      normalizeString(rate) ||
      normalizeString(total);

    if (!hasData) continue;

    items.push({
      pieces: pieces !== '' && pieces != null ? Number(pieces) : null,
      gross_weight: grossWeight !== '' && grossWeight != null ? Number(grossWeight) : null,
      dimensions: normalizeString(dimensions) || null,
      goods_description: normalizeString(goodsDescription) || null,
      rate_class: normalizeString(rateClass) || null,
      chargeable_weight: chargeableWeight !== '' && chargeableWeight != null ? Number(chargeableWeight) : null,
      rate: rate !== '' && rate != null ? Number(rate) : null,
      total: total !== '' && total != null ? Number(total) : null
    });
  }
  return items;
}

function fetchAwbById(awbId, companyId, callback) {
  db.get('SELECT * FROM awbs WHERE id = ? AND company_id = ?', [awbId, companyId], (err, row) => {
    if (err || !row) return callback(err || new Error('awb_not_found'));
    return callback(null, row);
  });
}

function fetchAwbItems(awbId, callback) {
  db.all('SELECT * FROM awb_items WHERE awb_id = ? ORDER BY id ASC', [awbId], (err, rows) => {
    return callback(err ? [] : rows || []);
  });
}

function fetchAwbLinkedManifests(awbId, companyId, callback) {
  db.all(
    `SELECT m.*,
            (SELECT COUNT(*) FROM manifest_pieces mp WHERE mp.manifest_id = m.id) AS piece_count,
            (SELECT COUNT(*)
             FROM manifest_piece_packages mpp
             JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
             WHERE mp.manifest_id = m.id) AS package_count,
            (SELECT SUM(p.weight_lbs)
             FROM manifest_piece_packages mpp
             JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
             JOIN packages p ON p.id = mpp.package_id
             WHERE mp.manifest_id = m.id) AS total_weight
     FROM awb_manifests am
     JOIN manifests m ON m.id = am.manifest_id
     WHERE am.awb_id = ? AND m.company_id = ?
     ORDER BY m.created_at DESC`,
    [awbId, companyId],
    (err, rows) => callback(err ? [] : rows || [])
  );
}

function fetchAvailableManifestsForAwb(awbId, companyId, callback) {
  db.all(
    `SELECT m.*
     FROM manifests m
     WHERE m.company_id = ?
       AND m.id NOT IN (SELECT manifest_id FROM awb_manifests WHERE awb_id = ?)
     ORDER BY m.created_at DESC`,
    [companyId, awbId],
    (err, rows) => callback(err ? [] : rows || [])
  );
}

function computeManifestTotals(manifests) {
  const totals = { totalPieces: 0, totalPackages: 0, totalWeight: 0 };
  (manifests || []).forEach((m) => {
    totals.totalPieces += Number(m.piece_count || 0);
    totals.totalPackages += Number(m.package_count || 0);
    totals.totalWeight += Number(m.total_weight || 0);
  });
  return totals;
}

function loadCuscarCatalogs(companyId, callback) {
  const catalogDefs = [
    { key: 'transporters', type: 'transporters' },
    { key: 'consignatarios', type: 'consignatarios' },
    { key: 'remitentes', type: 'remitentes' },
    { key: 'airlines', type: 'airlines' },
    { key: 'ports', type: 'ports' },
    { key: 'airports', type: 'airports' },
    { key: 'customsOffices', type: 'customs_offices' },
    { key: 'countries', type: 'countries' },
    { key: 'packageTypes', type: 'package_types' },
    { key: 'units', type: 'units' },
    { key: 'transportModes', type: 'transport_modes' },
    { key: 'transportMeans', type: 'transport_means' },
    { key: 'messageTypes', type: 'message_types' },
    { key: 'messageFunctions', type: 'message_functions' },
    { key: 'referenceQualifiers', type: 'reference_qualifiers' },
    { key: 'messageResponsibles', type: 'message_responsibles' },
    { key: 'transportIdAgencies', type: 'transport_id_agencies' }
  ];
  const result = {};
  if (!companyId) return callback(result);
  let pending = catalogDefs.length;
  catalogDefs.forEach((def) => {
    const catalog = CUSCAR_CATALOGS[def.type];
    if (!catalog) {
      result[def.key] = [];
      pending -= 1;
      if (pending <= 0) return callback(result);
      return;
    }
    let where = '';
    const params = [];
    if (catalog.scope === 'global') {
      where = 'company_id = 0';
    } else if (catalog.scope === 'company') {
      where = 'company_id = ?';
      params.push(companyId);
    } else {
      where = 'company_id IN (0, ?)';
      params.push(companyId);
    }
    db.all(
      `SELECT id, code, name, description, is_active, source, sort_order
       FROM ${catalog.table}
       WHERE ${where} AND is_active = 1
       ORDER BY sort_order ASC, name ASC`,
      params,
      (err, rows) => {
        result[def.key] = err ? [] : rows || [];
        pending -= 1;
        if (pending <= 0) return callback(result);
      }
    );
  });
}

function normalizeCuscarSeedEntry(entry, index, fallbackSource) {
  if (!entry || typeof entry !== 'object') return null;
  const code = normalizeString(entry.code);
  const name = normalizeString(entry.name);
  if (!code || !name) return null;
  const description = normalizeString(entry.description);
  const isActive =
    entry.is_active === undefined || entry.is_active === null ? 1 : Number(entry.is_active) ? 1 : 0;
  const sortOrderRaw = entry.sort_order !== undefined && entry.sort_order !== null ? Number(entry.sort_order) : null;
  const sortOrder = Number.isFinite(sortOrderRaw) ? sortOrderRaw : index + 1;
  const source = normalizeString(entry.source) || fallbackSource || 'SAT';
  return { code, name, description, is_active: isActive, sort_order: sortOrder, source };
}

function seedCuscarBaseCatalogs(options, callback) {
  const opts = options || {};
  let seedData = null;
  try {
    if (fs.existsSync(CUSCAR_BASE_CATALOG_PATH)) {
      seedData = readJsonFile(CUSCAR_BASE_CATALOG_PATH);
    }
  } catch (err) {
    console.warn('[cuscar] No se pudo leer el archivo de catÃ¡logos base:', err.message);
  }
  if (!seedData || typeof seedData !== 'object') {
    if (callback) callback();
    return;
  }
  const targetType = opts.type || null;
  const catalogEntries = Object.values(CUSCAR_CATALOGS).filter(
    (catalog) => catalog.seedKey && (!targetType || catalog.type === targetType)
  );
  if (!catalogEntries.length) {
    if (callback) callback();
    return;
  }
  const onlyIfEmpty = Boolean(opts.onlyIfEmpty);
  db.all('SELECT id FROM companies', (err, companies) => {
    const companyIds = err ? [] : (companies || []).map((row) => row.id).filter((id) => Number.isInteger(id));
    let pendingCatalogs = catalogEntries.length;
    const finishCatalog = () => {
      pendingCatalogs -= 1;
      if (pendingCatalogs <= 0 && callback) callback();
    };
    catalogEntries.forEach((catalog) => {
      const rows = Array.isArray(seedData[catalog.seedKey]) ? seedData[catalog.seedKey] : [];
      if (!rows.length) {
        finishCatalog();
        return;
      }
      const targetCompanies =
        catalog.seedScope === 'company'
          ? companyIds
          : [0];
      if (!targetCompanies.length) {
        finishCatalog();
        return;
      }
      let pendingCompanies = targetCompanies.length;
      const finishCompany = () => {
        pendingCompanies -= 1;
        if (pendingCompanies <= 0) finishCatalog();
      };
      targetCompanies.forEach((companyId) => {
        if (onlyIfEmpty) {
          db.get(
            `SELECT COUNT(*) AS total FROM ${catalog.table} WHERE company_id = ?`,
            [companyId],
            (countErr, row) => {
              if (!countErr && row && Number(row.total || 0) > 0) {
                finishCompany();
                return;
              }
              seedCuscarCatalogRows(catalog, rows, companyId, finishCompany);
            }
          );
          return;
        }
        seedCuscarCatalogRows(catalog, rows, companyId, finishCompany);
      });
    });
  });
}

function seedCuscarCatalogRows(catalog, rows, companyId, done) {
  let pending = rows.length;
  if (!pending) {
    if (done) done();
    return;
  }
  rows.forEach((row, index) => {
    const fallbackSource = catalog.seedScope === 'company' ? 'BASE' : 'SAT';
    const normalized = normalizeCuscarSeedEntry(row, index, fallbackSource);
    if (!normalized) {
      pending -= 1;
      if (pending <= 0 && done) done();
      return;
    }
    db.get(
      `SELECT id FROM ${catalog.table} WHERE company_id = ? AND code = ? LIMIT 1`,
      [companyId, normalized.code],
      (lookupErr, existing) => {
        if (existing && existing.id) {
          db.run(
            `UPDATE ${catalog.table}
             SET name = ?, description = ?, is_active = ?, source = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              normalized.name,
              normalized.description || null,
              normalized.is_active,
              normalized.source,
              normalized.sort_order,
              existing.id
            ],
            () => {
              pending -= 1;
              if (pending <= 0 && done) done();
            }
          );
          return;
        }
        db.run(
          `INSERT INTO ${catalog.table}
           (company_id, code, name, description, is_active, source, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            companyId,
            normalized.code,
            normalized.name,
            normalized.description || null,
            normalized.is_active,
            normalized.source,
            normalized.sort_order
          ],
          () => {
            pending -= 1;
            if (pending <= 0 && done) done();
          }
        );
      }
    );
  });
}

function validateCuscarManifestForClose(manifestId, companyId, t, callback) {
  const errors = [];
  if (!manifestId || !companyId) {
    errors.push(t('cuscar.errors.manifest_not_found'));
    return callback(errors);
  }
  db.get(
    `SELECT m.*,
        tr.id AS transporter_exists,
        al.id AS airline_exists,
        op.id AS origin_port_exists,
        oa.id AS origin_airport_exists,
        dp.id AS destination_port_exists,
        da.id AS destination_airport_exists,
        cp.id AS customs_port_exists,
        co.id AS customs_office_exists,
        tm.id AS transport_mode_exists,
        tme.id AS transport_means_exists,
        mt.id AS message_type_exists,
        mf.id AS message_function_exists,
        mr.id AS message_responsible_exists,
        rq.id AS reference_qualifier_exists,
        tia.id AS transport_id_agency_exists
     FROM cuscar_manifests m
     LEFT JOIN cuscar_transporters tr ON tr.id = m.transporter_id AND tr.company_id = m.company_id
     LEFT JOIN cuscar_airlines al ON al.id = m.airline_id AND (al.company_id = 0 OR al.company_id = m.company_id)
     LEFT JOIN cuscar_ports op ON op.id = m.origin_port_id AND (op.company_id = 0 OR op.company_id = m.company_id)
     LEFT JOIN cuscar_airports oa ON oa.id = m.origin_airport_id AND oa.company_id = 0
     LEFT JOIN cuscar_ports dp ON dp.id = m.destination_port_id AND (dp.company_id = 0 OR dp.company_id = m.company_id)
     LEFT JOIN cuscar_airports da ON da.id = m.destination_airport_id AND da.company_id = 0
     LEFT JOIN cuscar_ports cp ON cp.id = m.customs_port_id AND (cp.company_id = 0 OR cp.company_id = m.company_id)
     LEFT JOIN cuscar_customs_offices co ON co.id = m.customs_office_id AND co.company_id = 0
     LEFT JOIN cuscar_transport_modes tm ON tm.id = m.transport_mode_id AND tm.company_id = 0
     LEFT JOIN cuscar_transport_means tme ON tme.id = m.transport_means_id AND tme.company_id = 0
     LEFT JOIN cuscar_message_types mt ON mt.id = m.message_type_id AND mt.company_id = 0
     LEFT JOIN cuscar_message_functions mf ON mf.id = m.message_function_id AND mf.company_id = 0
     LEFT JOIN cuscar_message_responsibles mr ON mr.id = m.message_responsible_id AND mr.company_id = 0
     LEFT JOIN cuscar_reference_qualifiers rq ON rq.id = m.reference_qualifier_id AND rq.company_id = 0
     LEFT JOIN cuscar_transport_id_agencies tia ON tia.id = m.transport_id_agency_id AND tia.company_id = 0
     WHERE m.id = ? AND m.company_id = ?`,
    [manifestId, companyId],
    (err, manifest) => {
      if (err || !manifest) {
        errors.push(t('cuscar.errors.manifest_not_found'));
        return callback(errors);
      }
      const requiredFields = [
        { key: 'internal_number', label: t('cuscar.fields.internal_number') },
        { key: 'master_airway_bill', label: t('cuscar.fields.master_airway_bill') },
        { key: 'flight_number', label: t('cuscar.fields.flight_number') },
        { key: 'flight_date', label: t('cuscar.fields.flight_date') },
        { key: 'airline_id', label: t('cuscar.fields.airline'), numeric: true },
        { key: 'transport_mode_id', label: t('cuscar.fields.transport_mode'), numeric: true },
        { key: 'transport_means_id', label: t('cuscar.fields.transport_means'), numeric: true },
        { key: 'message_type_id', label: t('cuscar.fields.message_type'), numeric: true },
        { key: 'message_function_id', label: t('cuscar.fields.message_function'), numeric: true },
        { key: 'message_responsible_id', label: t('cuscar.fields.message_responsible'), numeric: true },
        { key: 'reference_qualifier_id', label: t('cuscar.fields.reference_qualifier'), numeric: true },
        { key: 'transport_id_agency_id', label: t('cuscar.fields.transport_id_agency'), numeric: true },
        { key: 'transporter_id', label: t('cuscar.fields.transporter'), numeric: true }
      ];
      requiredFields.forEach((field) => {
        const value = manifest[field.key];
        const missing = field.numeric
          ? !Number(value) || Number(value) <= 0
          : value === null || value === undefined || String(value).trim() === '';
        if (missing) {
          errors.push(t('cuscar.errors.required_field', { field: field.label }));
        }
      });
      const hasOrigin = manifest.origin_port_exists || manifest.origin_airport_exists;
      const hasDestination = manifest.destination_port_exists || manifest.destination_airport_exists;
      if (!hasOrigin) errors.push(t('cuscar.errors.origin_required'));
      if (!hasDestination) errors.push(t('cuscar.errors.destination_required'));
      const hasCustoms = manifest.customs_office_exists || manifest.customs_port_exists;
      if (!hasCustoms) errors.push(t('cuscar.errors.customs_required'));
      if (
        !manifest.transporter_exists ||
        !manifest.airline_exists ||
        !manifest.transport_mode_exists ||
        !manifest.transport_means_exists ||
        !manifest.message_type_exists ||
        !manifest.message_function_exists ||
        !manifest.message_responsible_exists ||
        !manifest.reference_qualifier_exists ||
        !manifest.transport_id_agency_exists
      ) {
        errors.push(t('cuscar.errors.invalid_catalog'));
      }
      db.all(
        `SELECT mi.*,
            sh.id AS shipper_exists,
            co.id AS consignee_exists,
            pt.id AS package_type_exists,
            oc.id AS country_exists,
            wu.id AS weight_unit_exists
         FROM cuscar_manifest_items mi
         LEFT JOIN cuscar_remitentes sh ON sh.id = mi.shipper_id AND sh.company_id = mi.company_id
         LEFT JOIN cuscar_consignatarios co ON co.id = mi.consignee_id AND co.company_id = mi.company_id
         LEFT JOIN cuscar_package_types pt ON pt.id = mi.package_type_id AND (pt.company_id = 0 OR pt.company_id = mi.company_id)
         LEFT JOIN cuscar_countries oc ON oc.id = mi.origin_country_id AND (oc.company_id = 0 OR oc.company_id = mi.company_id)
         LEFT JOIN cuscar_units wu ON wu.id = mi.weight_unit_id AND (wu.company_id = 0 OR wu.company_id = mi.company_id)
         WHERE mi.manifest_id = ? AND mi.company_id = ?
         ORDER BY mi.id ASC`,
        [manifestId, companyId],
        (itemErr, items) => {
          if (itemErr) {
            errors.push(t('cuscar.errors.items_required'));
            return callback(errors, manifest, []);
          }
          if (!items || items.length === 0) {
            errors.push(t('cuscar.errors.items_required'));
            return callback(errors, manifest, []);
          }
          let itemHasErrors = false;
          (items || []).forEach((item) => {
            if (!item.hawb_number || !item.goods_description) itemHasErrors = true;
            const numericFields = [
              item.package_qty,
              item.gross_weight,
              item.net_weight,
              item.declared_value
            ];
            numericFields.forEach((val) => {
              if (val === null || val === undefined || Number(val) < 0) itemHasErrors = true;
            });
            if (
              !item.shipper_exists ||
              !item.consignee_exists ||
              !item.package_type_exists ||
              !item.country_exists ||
              !item.weight_unit_exists
            ) {
              itemHasErrors = true;
            }
          });
          if (itemHasErrors) {
            errors.push(t('cuscar.errors.items_invalid'));
          }
          return callback(errors, manifest, items);
        }
      );
    }
  );
}

function buildCuscarPreviewText(manifest, items) {
  const lines = [];
  const originLabel = manifest.origin_airport_name || manifest.origin_port_name || '-';
  const destinationLabel = manifest.destination_airport_name || manifest.destination_port_name || '-';
  const customsLabel = manifest.customs_office_name || manifest.customs_port_name || '-';
  lines.push('CUSCAR SAT - VISTA PREVIA');
  lines.push(`Manifiesto interno: ${manifest.internal_number}`);
  lines.push(`GuÃ­a master: ${manifest.master_airway_bill}`);
  lines.push(`Vuelo: ${manifest.flight_number} | Fecha: ${manifest.flight_date}`);
  lines.push(`AerolÃ­nea: ${manifest.airline_name || '-'}`);
  lines.push(`Modo transporte: ${manifest.transport_mode_name || '-'}`);
  lines.push(`Medio transporte: ${manifest.transport_means_name || '-'}`);
  lines.push(`Tipo mensaje: ${manifest.message_type_name || '-'}`);
  lines.push(`FunciÃ³n mensaje: ${manifest.message_function_name || '-'}`);
  lines.push(`Responsable mensaje: ${manifest.message_responsible_name || '-'}`);
  lines.push(`Calificador referencia: ${manifest.reference_qualifier_name || '-'}`);
  lines.push(`Agencia identificaciÃ³n medio: ${manifest.transport_id_agency_name || '-'}`);
  lines.push(`Origen: ${originLabel}`);
  lines.push(`Destino: ${destinationLabel}`);
  lines.push(`Aduana ingreso: ${customsLabel}`);
  lines.push(`Transportista: ${manifest.transporter_name || '-'}`);
  lines.push(`Estado: ${manifest.status || '-'}`);
  if (manifest.observations) {
    lines.push(`Observaciones: ${manifest.observations}`);
  }
  lines.push('');
  lines.push('GUIAS HIJAS');
  (items || []).forEach((item, idx) => {
    lines.push(
      `${idx + 1}. HAWB: ${item.hawb_number} | Remitente: ${item.shipper_name || '-'} | Consignatario: ${item.consignee_name || '-'}`
    );
    lines.push(`   MercancÃ­a: ${item.goods_description || '-'}`);
    lines.push(
      `   Bultos: ${Number(item.package_qty || 0)} ${item.package_type_name || ''} | Peso bruto: ${Number(item.gross_weight || 0).toFixed(2)} ${item.weight_unit_name || ''} | Peso neto: ${Number(item.net_weight || 0).toFixed(2)} ${item.weight_unit_name || ''}`
    );
    lines.push(`   Valor declarado: ${Number(item.declared_value || 0).toFixed(2)} | PaÃ­s origen: ${item.country_name || '-'}`);
    if (item.observations) lines.push(`   Observaciones: ${item.observations}`);
  });
  return lines.join('\n');
}

function fetchCuscarManifestDetail(manifestId, companyId, callback) {
  db.get(
    `SELECT m.*,
        tr.name AS transporter_name,
        al.name AS airline_name,
        op.name AS origin_port_name,
        oa.name AS origin_airport_name,
        dp.name AS destination_port_name,
        da.name AS destination_airport_name,
        cp.name AS customs_port_name,
        co.name AS customs_office_name,
        tm.name AS transport_mode_name,
        tme.name AS transport_means_name,
        mt.name AS message_type_name,
        mf.name AS message_function_name,
        mr.name AS message_responsible_name,
        rq.name AS reference_qualifier_name,
        tia.name AS transport_id_agency_name
     FROM cuscar_manifests m
     LEFT JOIN cuscar_transporters tr ON tr.id = m.transporter_id AND tr.company_id = m.company_id
     LEFT JOIN cuscar_airlines al ON al.id = m.airline_id AND (al.company_id = 0 OR al.company_id = m.company_id)
     LEFT JOIN cuscar_ports op ON op.id = m.origin_port_id AND (op.company_id = 0 OR op.company_id = m.company_id)
     LEFT JOIN cuscar_airports oa ON oa.id = m.origin_airport_id AND oa.company_id = 0
     LEFT JOIN cuscar_ports dp ON dp.id = m.destination_port_id AND (dp.company_id = 0 OR dp.company_id = m.company_id)
     LEFT JOIN cuscar_airports da ON da.id = m.destination_airport_id AND da.company_id = 0
     LEFT JOIN cuscar_ports cp ON cp.id = m.customs_port_id AND (cp.company_id = 0 OR cp.company_id = m.company_id)
     LEFT JOIN cuscar_customs_offices co ON co.id = m.customs_office_id AND co.company_id = 0
     LEFT JOIN cuscar_transport_modes tm ON tm.id = m.transport_mode_id AND tm.company_id = 0
     LEFT JOIN cuscar_transport_means tme ON tme.id = m.transport_means_id AND tme.company_id = 0
     LEFT JOIN cuscar_message_types mt ON mt.id = m.message_type_id AND mt.company_id = 0
     LEFT JOIN cuscar_message_functions mf ON mf.id = m.message_function_id AND mf.company_id = 0
     LEFT JOIN cuscar_message_responsibles mr ON mr.id = m.message_responsible_id AND mr.company_id = 0
     LEFT JOIN cuscar_reference_qualifiers rq ON rq.id = m.reference_qualifier_id AND rq.company_id = 0
     LEFT JOIN cuscar_transport_id_agencies tia ON tia.id = m.transport_id_agency_id AND tia.company_id = 0
     WHERE m.id = ? AND m.company_id = ?`,
    [manifestId, companyId],
    (err, manifest) => {
      if (err || !manifest) return callback(err || new Error('not_found'), null, []);
      db.all(
        `SELECT mi.*,
            sh.name AS shipper_name,
            co.name AS consignee_name,
            pt.name AS package_type_name,
            oc.name AS country_name,
            wu.name AS weight_unit_name
         FROM cuscar_manifest_items mi
         LEFT JOIN cuscar_remitentes sh ON sh.id = mi.shipper_id AND sh.company_id = mi.company_id
         LEFT JOIN cuscar_consignatarios co ON co.id = mi.consignee_id AND co.company_id = mi.company_id
         LEFT JOIN cuscar_package_types pt ON pt.id = mi.package_type_id AND (pt.company_id = 0 OR pt.company_id = mi.company_id)
         LEFT JOIN cuscar_countries oc ON oc.id = mi.origin_country_id AND (oc.company_id = 0 OR oc.company_id = mi.company_id)
         LEFT JOIN cuscar_units wu ON wu.id = mi.weight_unit_id AND (wu.company_id = 0 OR wu.company_id = mi.company_id)
         WHERE mi.manifest_id = ? AND mi.company_id = ?
         ORDER BY mi.id ASC`,
        [manifestId, companyId],
        (itemErr, items) => callback(itemErr, manifest, itemErr ? [] : items || [])
      );
    }
  );
}

function buildCuscarPayload(manifest, items) {
  const originLabel = manifest.origin_airport_name || manifest.origin_port_name || null;
  const destinationLabel = manifest.destination_airport_name || manifest.destination_port_name || null;
  const customsLabel = manifest.customs_office_name || manifest.customs_port_name || null;
  const payload = {
    header: {
      internal_number: manifest.internal_number,
      master_airway_bill: manifest.master_airway_bill,
      flight_number: manifest.flight_number,
      flight_date: manifest.flight_date,
      airline: manifest.airline_name || null,
      transport_mode: manifest.transport_mode_name || null,
      transport_means: manifest.transport_means_name || null,
      message_type: manifest.message_type_name || null,
      message_function: manifest.message_function_name || null,
      message_responsible: manifest.message_responsible_name || null,
      reference_qualifier: manifest.reference_qualifier_name || null,
      transport_id_agency: manifest.transport_id_agency_name || null,
      origin: originLabel,
      destination: destinationLabel,
      customs_entry: customsLabel,
      transporter: manifest.transporter_name || null,
      observations: manifest.observations || null
    },
    items: (items || []).map((item) => ({
      hawb_number: item.hawb_number,
      shipper: item.shipper_name || null,
      consignee: item.consignee_name || null,
      goods_description: item.goods_description || null,
      package_qty: Number(item.package_qty || 0),
      package_type: item.package_type_name || null,
      gross_weight: Number(item.gross_weight || 0),
      net_weight: Number(item.net_weight || 0),
      weight_unit: item.weight_unit_name || null,
      declared_value: Number(item.declared_value || 0),
      origin_country: item.country_name || null,
      observations: item.observations || null
    }))
  };
  return JSON.stringify(payload, null, 2);
}

function simulateCusresResponse(manifest, payloadText) {
  const internalNumber = String(manifest.internal_number || '').toLowerCase();
  const forceError = internalNumber.includes('err') || internalNumber.includes('error');
  if (forceError) {
    return {
      ok: false,
      code: 'CUSRES-ERR',
      message: 'SimulaciÃ³n: error de validaciÃ³n en SAT',
      raw: JSON.stringify({ status: 'ERROR', detail: 'Simulated validation error' })
    };
  }
  return {
    ok: true,
    code: 'CUSRES-OK',
    message: 'SimulaciÃ³n: CUSCAR recibido',
    raw: JSON.stringify({ status: 'OK', receipt: `CUSRES-${Date.now()}` })
  };
}

function transmitCuscarManifest(manifestId, companyId, userId, callback) {
  fetchCuscarManifestDetail(manifestId, companyId, (err, manifest, items) => {
    if (err || !manifest) return callback(new Error('manifest_not_found'));
    const allowedStatus = ['closed', 'generated', 'ready_to_generate'];
    if (!allowedStatus.includes(manifest.status)) return callback(new Error('invalid_status'));
    const payloadText = buildCuscarPayload(manifest, items);
    const endpoint = SAT_ENV === 'prod' ? SAT_ENDPOINT_PROD : SAT_ENDPOINT_TEST;
    const mode = SAT_ENV === 'simulation' ? 'simulation' : SAT_ENV;
    db.run(
      `INSERT INTO cuscar_transmissions
       (company_id, manifest_id, payload_text, status, mode, endpoint, requested_by)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [companyId, manifestId, payloadText, mode, endpoint || null, userId],
      function onInsert(insertErr) {
        if (insertErr) return callback(insertErr);
        const transmissionId = this.lastID;
        if (SAT_ENV === 'simulation') {
          const simulated = simulateCusresResponse(manifest, payloadText);
          if (simulated.ok) {
            db.run(
              "UPDATE cuscar_transmissions SET status = 'success' WHERE id = ?",
              [transmissionId]
            );
            db.run(
              `INSERT INTO cuscar_transmission_responses
               (transmission_id, response_code, response_message, raw_response)
               VALUES (?, ?, ?, ?)`,
              [transmissionId, simulated.code, simulated.message, simulated.raw]
            );
            db.run(
              "UPDATE cuscar_manifests SET status = 'transmitted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
              [manifestId, companyId]
            );
            return callback(null, { ok: true, transmissionId, simulated });
          }
          db.run(
            "UPDATE cuscar_transmissions SET status = 'error' WHERE id = ?",
            [transmissionId]
          );
          db.run(
            `INSERT INTO cuscar_transmission_errors
             (transmission_id, error_message, error_detail)
             VALUES (?, ?, ?)`,
            [transmissionId, simulated.message, simulated.raw]
          );
          db.run(
            "UPDATE cuscar_manifests SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
            [manifestId, companyId]
          );
          return callback(null, { ok: false, transmissionId, simulated });
        }
        // Placeholder for real SAT integration (test/prod).
        db.run(
          "UPDATE cuscar_transmissions SET status = 'pending' WHERE id = ?",
          [transmissionId]
        );
        return callback(null, { ok: true, transmissionId, simulated: null });
      }
    );
  });
}

function fetchCarrierReceptionStats(companyId, callback) {
  const result = {
    stats: { receivedToday: 0, pending: 0, processed: 0 },
    carrierTotals: [],
    carrierTodayTotals: []
  };
  if (!companyId) return callback(result);

  let pending = 3;
  const done = () => {
    pending -= 1;
    if (pending <= 0) return callback(result);
  };

  db.get(
    `SELECT
      SUM(CASE WHEN date(received_at) = date('now','localtime') THEN 1 ELSE 0 END) AS received_today,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed
     FROM carrier_receptions
     WHERE company_id = ?`,
    [companyId],
    (err, row) => {
      if (!err && row) {
        result.stats.receivedToday = Number(row.received_today || 0);
        result.stats.pending = Number(row.pending || 0);
        result.stats.processed = Number(row.processed || 0);
      }
      done();
    }
  );

  db.all(
    `SELECT carrier, COUNT(*) AS count
     FROM carrier_receptions
     WHERE company_id = ?
     GROUP BY carrier
     ORDER BY count DESC`,
    [companyId],
    (err, rows) => {
      result.carrierTotals = err ? [] : rows || [];
      done();
    }
  );

  db.all(
    `SELECT carrier, COUNT(*) AS count
     FROM carrier_receptions
     WHERE company_id = ? AND date(received_at) = date('now','localtime')
     GROUP BY carrier
     ORDER BY count DESC`,
    [companyId],
    (err, rows) => {
      result.carrierTodayTotals = err ? [] : rows || [];
      done();
    }
  );
}

function fetchCarrierReceptionList(companyId, filters, callback) {
  const params = [companyId];
  let whereClause = 'WHERE company_id = ?';

  if (filters && filters.tracking) {
    whereClause += ' AND tracking_number LIKE ?';
    params.push(`%${filters.tracking}%`);
  }
  if (filters && filters.carrier) {
    whereClause += ' AND carrier LIKE ?';
    params.push(`%${filters.carrier}%`);
  }
  if (filters && filters.date) {
    whereClause += " AND date(received_at) = date(?)";
    params.push(filters.date);
  }
  if (filters) {
    const statusFilter = filters.status || 'pending';
    if (statusFilter && statusFilter !== 'all') {
      whereClause += ' AND status = ?';
      params.push(statusFilter);
    }
  }

  const sql = `SELECT * FROM carrier_receptions ${whereClause} ORDER BY received_at DESC`;
  db.all(sql, params, (err, rows) => callback(err ? [] : rows || []));
}
registerAuthRoutes(app, {
  db,
  bcrypt,
  normalizeString,
  getClientIp,
  isCompanyExpired,
  parseJsonList,
  normalizeAllowedModules,
  getPermissionMap,
  verifyFileToken,
  rateLimiter,
  loginRateLimit,
  masterLoginRateLimit,
  AUTH_LIMIT_WINDOW_MS,
  LOGIN_LIMIT_MAX,
  MASTER_LOGIN_LIMIT_MAX,
  MASTER_USER,
  MASTER_PASS,
  DEFAULT_LANG,
  SUPPORTED_LANGS,
  SESSION_COOKIE_NAME
});

registerMasterAuthRoutes(app, {
  normalizeString,
  getClientIp,
  rateLimiter,
  masterLoginRateLimit,
  AUTH_LIMIT_WINDOW_MS,
  MASTER_LOGIN_LIMIT_MAX,
  MASTER_USER,
  MASTER_PASS,
  DEFAULT_LANG,
  SUPPORTED_LANGS,
  SESSION_COOKIE_NAME
});

registerCompanyRoutes(app, {
  db,
  bcrypt,
  requireMaster,
  companyLogoUpload,
  csrfMiddleware,
  loadBusinessActivities,
  buildCompanyStatus,
  setFlash,
  parseJsonList,
  normalizeAllowedModules,
  getPermissionMap,
  normalizeString,
  parseCurrencyList,
  resolveCompanyActiveWindow,
  seedAccountingCategories,
  seedNifCatalog,
  getIsStartingUp: () => isStartingUp
});

registerMasterCompanyRoutes(app, {
  db,
  bcrypt,
  requireMaster,
  loadBusinessActivities,
  buildCompanyStatus,
  setFlash,
  parseJsonList,
  normalizeAllowedModules,
  getPermissionMap,
  parseCurrencyList,
  resolveCompanyActiveWindow,
  seedAccountingCategories,
  seedNifCatalog,
  getIsStartingUp: () => isStartingUp
});

registerPackageRoutes(app, {
  db,
  stringify,
  requireAuth,
  requirePermission,
  getCompanyId,
  computePackageStats,
  normalizeString,
  computePackageStatusCounts,
  fetchPackagesList,
  PACKAGE_STATUSES,
  URGENT_STUCK_DAYS,
  URGENT_INVOICE_DAYS,
  URGENT_CUSTOMS_DAYS,
  fetchPendingInvoicePackages,
  setFlash,
  findPackagesTable,
  updatePackageStatusWithHistory,
  getPackageLabelLayout,
  savePackageLabelLayout,
  verifyInvoiceUploadToken,
  fetchPackageDetail,
  packageUpload,
  csrfMiddleware,
  resolveConsignatarioWithCustomer,
  getCustomerStatusById,
  generateInternalCode,
  getPackageSenderSettings,
  toNumberOrNull,
  insertPackagePhotos,
  buildFileUrl,
  fetchPackageHistory,
  fetchPackageComments,
  buildPackageLabelData,
  getCompanyBrandById,
  buildPackageUrl,
  generateBarcodeDataUrl,
  generateQrDataUrl,
  sendWhatsappMessage,
  buildPackageInvoiceUploadUrl,
  buildInvoiceRequestMessage,
  sendInvoiceEmail
});

registerCustomerRoutes(app, {
  db,
  path,
  parse,
  XLSX,
  upload,
  csrfMiddleware,
  bcrypt,
  requireAuth,
  requirePermission,
  requireCustomer,
  getCompanyId,
  normalizeString,
  normalizeDocumentType,
  resolveSatFields,
  parseCurrencyList,
  findPackagesTable,
  findCustomerTable,
  buildFileUrl,
  getClientIp,
  rateLimiter,
  trackingRateLimit,
  TRACKING_LIMIT_WINDOW_MS,
  TRACKING_LIMIT_MAX,
  customerPortalRateLimit,
  CUSTOMER_PORTAL_WINDOW_MS,
  CUSTOMER_PORTAL_MAX,
  PACKAGE_STATUSES,
  getCompanyBrandById,
  renderCustomers,
  buildCustomerListQuery,
  generatePortalCode,
  generatePortalPassword,
  generateCustomerCode,
  renderConsignatarios,
  resolveConsignatariosSort,
  buildConsignatariosListQuery,
  getCustomerStatusById,
  setFlash,
  logAction,
  formatSqliteError,
  requestSatLookup,
  SAT_PORTAL_URL,
  CUSTOMER_DOCUMENT_TYPES,
  COMPANY_COUNTRIES,
  PAYMENT_METHODS,
  COMMUNICATION_TYPES
});

registerCarrierReceptionRoutes(app, {
  stringify,
  requireAuth,
  requirePermission,
  getCompanyId,
  normalizeString,
  fetchCarrierReceptionStats,
  fetchCarrierReceptionList,
  getCarrierOptions
});

registerInventoryRoutes(app, {
  db,
  parse,
  stringify,
  upload,
  csrfMiddleware,
  requireAuth,
  requirePermission,
  getCompanyId,
  normalizeString,
  renderInventory,
  renderCategories,
  renderBrands,
  resolveCategoryId,
  resolveBrandId,
  buildItemSku,
  inventoryRedirectPath,
  getOrCreateCategoryId,
  getOrCreateBrandId,
  generateUniqueSimpleCode,
  normalizeCode,
  codeFromName
});

registerAccountingRoutes(app, {
  db,
  XLSX,
  stringify,
  requireAuth,
  requirePermission,
  getCompanyId,
  getCompanySettings,
  fetchNifAccounts,
  fetchNifTrialBalance,
  fetchNifDiary,
  fetchNifLedger,
  computeNifFinancials,
  sendExcel,
  renderSimplePdf,
  parseCurrencyList,
  normalizeFramework,
  ACCOUNTING_FRAMEWORKS,
  fetchAccountingCategories,
  normalizeNifType,
  normalizeNifSubtype,
  autoAssignAccountCategoriesWithRules,
  buildAutoAssignPlan,
  seedNiifCatalog,
  parseJournalLines,
  validateJournalLines,
  computeCategoryTotals,
  createJournalEntry,
  enqueueDbTransaction,
  commitTransaction,
  rollbackTransaction,
  setFlash,
  logAction
});

registerLogisticsRoutes(app, {
  db,
  PDFDocument,
  requireAuth,
  requirePermission,
  hasPermission,
  getCompanyId,
  normalizeString,
  setFlash,
  logAction,
  CUSCAR_CATALOGS,
  CUSCAR_CATALOG_LIST,
  parseJsonList,
  loadCuscarCatalogs,
  seedCuscarBaseCatalogs,
  findPackagesTable,
  buildManifestDetailData,
  validateCuscarManifestForClose,
  buildCuscarPreviewText,
  fetchCuscarManifestDetail,
  transmitCuscarManifest,
  updatePackageStatusWithHistory,
  parseAwbItemsFromBody,
  toNumberOrNull,
  fetchAwbById,
  fetchAwbItems,
  fetchAwbLinkedManifests,
  fetchAvailableManifestsForAwb,
  computeManifestTotals
});

registerInvoiceRoutes(app, {
  db,
  requireAuth,
  requirePermission,
  getCompanyId,
  parseCurrencyList,
  renderInvoices,
  getCustomerStatusById,
  enqueueDbTransaction,
  commitTransaction,
  rollbackTransaction,
  logAction
});

registerAgendaMedicaRoutes(app, {
  db,
  requireAuth,
  requirePermission,
  getCompanyId,
  getCompanyBrandById,
  APPOINTMENT_STATUSES,
  APPOINTMENT_DEFAULT_DURATION
});

registerHrRoutes(app, {
  db,
  requireAuth,
  requirePermission,
  csrfMiddleware,
  getCompanyId,
  normalizeString,
  setFlash,
  buildFileUrl
});

registerUserRoutes(app, {
  db,
  bcrypt,
  requireAuth,
  requirePermission,
  getCompanyId,
  parseCurrencyList,
  renderInvoices,
  renderUsers,
  getIsStartingUp: () => isStartingUp,
  logAction,
  resolveCompanyLabel,
  assignDefaultDashboardPermission,
  enqueueDbTransaction,
  commitTransaction,
  rollbackTransaction
});

registerAuditRoutes(app, {
  db,
  requireAuth,
  requirePermission,
  getCompanyId,
  parseCurrencyList,
  renderInvoices
});

registerMasterActivitiesRoutes(app, {
  db,
  requireMaster,
  parseJsonList,
  normalizeString,
  normalizeModuleSelection,
  setFlash
});

registerMasterRoutes(app, {
  db,
  requireMaster,
  buildCompanyStatus
});

app.get('/dashboard', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return renderWorkspacePage(req, res, { settingsPanelOpen: false });
});

app.get('/workspace', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return renderWorkspacePage(req, res, { settingsPanelOpen: false });
});

app.get('/workspace/settings', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return renderWorkspacePage(req, res, { settingsPanelOpen: true });
});

app.get('/settings/workspace', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return renderWorkspacePage(req, res, { settingsPanelOpen: true });
});

app.get('/workspace/state', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  buildWorkspaceResponse(req, res, (err, payload) => {
    if (err) return res.status(500).json({ ok: false });
    return res.json({ ok: true, state: payload.workspaceState, companyBrand: payload.companyBrand });
  });
});

app.get('/workspace/global-dock', requireAuth, (req, res) => {
  buildWorkspaceResponse(req, res, (err, payload) => {
    if (err) return res.status(500).json({ ok: false });
    const labels = buildWorkspaceLabels(res.locals.lang);
    return res.json({
      ok: true,
      state: payload.workspaceState,
      companyBrand: payload.companyBrand,
      icons: payload.icons,
      currentPath: req.originalUrl || req.path || '/',
      labels: {
        modulesTitle: labels.modulesTitle,
        noModules: labels.noModules,
        showDock: res.locals.lang === 'en' ? 'Show dock' : 'Mostrar dock',
        hideDock: res.locals.lang === 'en' ? 'Hide dock' : 'Ocultar dock'
      }
    });
  });
});

app.post('/workspace/save', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const userId = req.session && req.session.user ? req.session.user.id : null;
  if (!companyId || !userId) return res.status(401).json({ ok: false });

  buildlauncherModules(db, res.locals.t, req.session.permissionMap, Boolean(req.session.master), (modules) => {
    const workspaceModules = filterWorkspaceModulesForPermissions(modules, req.session.permissionMap, Boolean(req.session.master));
    getCompanyBrandById(companyId, (companyBrand) => {
      const body = req.body || {};
      const isLayoutPayload = Array.isArray(body.modules) || Array.isArray(body.folders);
      const saveFn = isLayoutPayload
        ? (done) => saveUserWorkspaceState(userId, companyId, companyBrand, workspaceModules, body, done)
        : (done) => saveUserWorkspaceSettingsOnly(userId, companyId, companyBrand, workspaceModules, body.settings || body, done);
      saveFn((saveErr) => {
        if (saveErr) return res.status(500).json({ ok: false });
        buildWorkspaceResponse(req, res, (responseErr, payload) => {
          if (responseErr) return res.status(500).json({ ok: false });
          return res.json({ ok: true, state: payload.workspaceState, companyBrand: payload.companyBrand });
        });
      });
    });
  });
});

app.post('/workspace/reset', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const userId = req.session && req.session.user ? req.session.user.id : null;
  if (!companyId || !userId) return res.status(401).json({ ok: false });

  enqueueDbTransaction((finish) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM user_workspace_items WHERE user_id = ? AND company_id = ?', [userId, companyId], (itemsErr) => {
        if (itemsErr) {
          rollbackTransaction(finish, () => res.status(500).json({ ok: false }));
          return;
        }
        commitTransaction(finish, (commitErr) => {
          if (commitErr) {
            return res.status(500).json({ ok: false });
          }
          buildWorkspaceResponse(req, res, (responseErr, payload) => {
            if (responseErr) {
              return res.status(500).json({ ok: false });
            }
            return res.json({ ok: true, state: payload.workspaceState, companyBrand: payload.companyBrand });
          });
        });
      });
    });
  });
});

app.post('/workspace/settings/reset', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const userId = req.session && req.session.user ? req.session.user.id : null;
  if (!companyId || !userId) return res.status(401).json({ ok: false });

  enqueueDbTransaction((finish) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM user_workspace_settings WHERE user_id = ? AND company_id = ?', [userId, companyId], (settingsErr) => {
        if (settingsErr) {
          rollbackTransaction(finish, () => res.status(500).json({ ok: false }));
          return;
        }
        commitTransaction(finish, (commitErr) => {
          if (commitErr) {
            return res.status(500).json({ ok: false });
          }
          buildWorkspaceResponse(req, res, (responseErr, payload) => {
            if (responseErr) {
              return res.status(500).json({ ok: false });
            }
            return res.json({ ok: true, state: payload.workspaceState, companyBrand: payload.companyBrand });
          });
        });
      });
    });
  });
});

function sendLegacyLauncherDisabled(req, res) {
  return res.status(410).json({
    ok: false,
    code: 'legacy_launcher_disabled',
    redirect: '/settings/workspace'
  });
}

app.get('/settings/launcher', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return res.redirect(301, '/settings/workspace');
});

app.post('/settings/launcher', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return res.redirect(303, '/settings/workspace');
});

app.get('/launcher/settings', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return res.redirect(301, '/settings/workspace');
});

app.post('/launcher/settings', requireAuth, requirePermission('dashboard', 'view'), (req, res) => {
  return res.redirect(303, '/settings/workspace');
});

app.all('/launcher/order', requireAuth, requirePermission('dashboard', 'view'), sendLegacyLauncherDisabled);
app.all('/launcher/notes', requireAuth, requirePermission('dashboard', 'view'), sendLegacyLauncherDisabled);
app.all('/launcher/planner', requireAuth, requirePermission('dashboard', 'view'), sendLegacyLauncherDisabled);
app.all('/launcher/widgets', requireAuth, requirePermission('dashboard', 'view'), sendLegacyLauncherDisabled);

app.get('/settings', requireAuth, requirePermission('settings', 'view'), (req, res) => {
  res.render('settings');
});

app.get('/settings/labels', requireAuth, requirePermission('settings', 'view'), (req, res) => {
  res.render('settings-labels');
});

app.get('/settings/carriers', requireAuth, requirePermission('settings', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  db.get('SELECT carriers_text FROM carrier_settings WHERE company_id = ?', [companyId], (err, row) => {
    const carriersText = !err && row && row.carriers_text ? row.carriers_text : '';
    res.render('settings-carriers', { carriersText, message: null });
  });
});

app.post('/settings/carriers', requireAuth, requirePermission('settings', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const carriersText = normalizeString(req.body.carriers_text);
  db.get('SELECT id FROM carrier_settings WHERE company_id = ?', [companyId], (err, row) => {
    if (err) return res.render('settings-carriers', { carriersText, message: { type: 'error', message: res.locals.t('errors.server_try_again') } });
    if (row && row.id) {
      db.run(
        'UPDATE carrier_settings SET carriers_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
        [carriersText, row.id, companyId],
        () => res.render('settings-carriers', { carriersText, message: { type: 'success', message: res.locals.t('common.saved') } })
      );
      return;
    }
    db.run(
      'INSERT INTO carrier_settings (company_id, carriers_text) VALUES (?, ?)',
      [companyId, carriersText],
      () => res.render('settings-carriers', { carriersText, message: { type: 'success', message: res.locals.t('common.saved') } })
    );
  });
});

app.get('/settings/package-sender', requireAuth, requirePermission('settings', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  db.get(
    'SELECT sender_name, store_name FROM package_sender_settings WHERE company_id = ?',
    [companyId],
    (err, row) => {
      res.render('settings-package-sender', {
        senderName: !err && row ? row.sender_name || '' : '',
        storeName: !err && row ? row.store_name || '' : '',
        message: null
      });
    }
  );
});

app.post('/settings/package-sender', requireAuth, requirePermission('settings', 'manage'), (req, res) => {
  const companyId = getCompanyId(req);
  const senderName = normalizeString(req.body.sender_name) || null;
  const storeName = normalizeString(req.body.store_name) || null;

  db.get('SELECT id FROM package_sender_settings WHERE company_id = ?', [companyId], (err, row) => {
    if (err) {
      return res.render('settings-package-sender', {
        senderName: senderName || '',
        storeName: storeName || '',
        message: { type: 'error', message: res.locals.t('errors.server_try_again') }
      });
    }

    const afterSave = () => {
      db.run(
        'UPDATE packages SET sender_name = ?, store_name = ? WHERE company_id = ?',
        [senderName, storeName, companyId],
        () => res.render('settings-package-sender', {
          senderName: senderName || '',
          storeName: storeName || '',
          message: { type: 'success', message: res.locals.t('common.saved') }
        })
      );
    };

    if (row && row.id) {
      return db.run(
        'UPDATE package_sender_settings SET sender_name = ?, store_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
        [senderName, storeName, row.id, companyId],
        afterSave
      );
    }
    return db.run(
      'INSERT INTO package_sender_settings (company_id, sender_name, store_name) VALUES (?, ?, ?)',
      [companyId, senderName, storeName],
      afterSave
    );
  });
});

function startServer(port, attempts = 0) {
  const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    isStartingUp = false;
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = Number(port) + 1;
      if (SHOULD_AUTO_SELECT_PORT && attempts < MAX_PORT_RETRIES && Number.isFinite(nextPort)) {
        console.warn(`Port ${port} is already in use. Trying http://localhost:${nextPort}...`);
        startServer(nextPort, attempts + 1);
        return;
      }

      console.error(`Port ${port} is already in use.`);
      console.error('Close the process using that port or set another port with PORT=3001.');
      process.exit(1);
    }

    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

startServer(PORT);



app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    const hasCookieHeader = Boolean(req.headers && req.headers.cookie);
    const hasBodyToken = Boolean(req.body && req.body._csrf);
    const hasHeaderToken = Boolean(
      req.headers && (req.headers['x-csrf-token'] || req.headers['x-xsrf-token'])
    );
    const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
    console.error('[csrf] invalid token', {
      method: req.method,
      url: req.originalUrl,
      isMultipart: req.is('multipart/form-data'),
      hasCookieHeader,
      hasBodyToken,
      hasHeaderToken,
      bodyKeys
    });
    return res.status(403).send('Invalid CSRF token');
  }
  return next(err);
});













































