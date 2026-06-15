const TOOL_PERMISSIONS = {
  buscarCliente: ['customers', 'view'],
  listarClientes: ['customers', 'view'],
  obtenerCliente: ['customers', 'view'],
  crearCliente: ['customers', 'create'],
  editarCliente: ['customers', 'edit'],
  buscarFactura: ['billing', 'view'],
  facturasPendientes: ['billing', 'view'],
  facturasVencidas: ['billing', 'view'],
  ventasMesActual: ['billing', 'view'],
  ventasAnuales: ['billing', 'view'],
  buscarProducto: ['inventory', 'view'],
  stockDisponible: ['inventory', 'view'],
  productosBajoMinimo: ['inventory', 'view'],
  buscarTracking: ['packages', 'view'],
  paquetesPendientes: ['packages', 'view'],
  paquetesUrgentes: ['packages', 'view'],
  proyectosActivos: ['projects', 'view'],
  proyectosAtrasados: ['projects', 'view'],
  crearTarea: ['projects', 'create'],
  ventasPorVendedor: ['sales', 'view'],
  topClientes: ['sales', 'view'],
  ventasMes: ['sales', 'view'],
  ventasAnio: ['sales', 'view'],
  cotizacionesEnviadas: ['sales', 'view'],
  prepararCotizacion: ['sales', 'create'],
  crearCotizacion: ['sales', 'create'],
  generarDocumento: ['ai_empresarial', 'view'],
  buscarProveedor: ['suppliers', 'view'],
  listarProveedores: ['suppliers', 'view'],
  saldoProveedor: ['suppliers', 'view'],
  buscarEmpleado: ['rrhh', 'view'],
  vacacionesPendientes: ['rrhh', 'view'],
  asistenciaEmpleado: ['rrhh', 'view']
};

function hasToolPermission(context, tool) {
  if (!tool || !tool.name) return false;
  const requirement = tool.permission || TOOL_PERMISSIONS[tool.name];
  if (!requirement) return false;
  const [moduleCode, actionCode] = requirement;
  return canUseAITool(context.user || context, tool.name, moduleCode, actionCode, context.permissionMap, context.hasPermission);
}

function canUseAITool(user, toolName, moduleName, action, permissionMap, hasPermissionFn) {
  const map = permissionMap || (user && (user.permissionMap || user.permissions)) || {};
  if (typeof hasPermissionFn === 'function') {
    return hasPermissionFn(map, moduleName, action);
  }
  if (map.isAdmin) return isModuleAllowed(map, moduleName);
  return Boolean(
    isModuleAllowed(map, moduleName) &&
    map.modules &&
    map.modules[moduleName] &&
    map.modules[moduleName][action]
  );
}

function isModuleAllowed(permissionMap, moduleCode) {
  const allowed = permissionMap && Array.isArray(permissionMap.allowedModules) && permissionMap.allowedModules.length
    ? permissionMap.allowedModules
    : null;
  if (!allowed) return true;
  return allowed.includes(moduleCode);
}

function buildToolContext(req, deps) {
  const sessionUser = req.session && req.session.user ? req.session.user : null;
  if (!req.user && sessionUser) {
    req.user = sessionUser;
  }
  return {
    db: deps.db,
    companyId: deps.getCompanyId(req),
    userId: req.user && req.user.id ? req.user.id : null,
    user: req.user || null,
    permissionMap: req.session ? req.session.permissionMap : null,
    hasPermission: deps.hasPermission
  };
}

module.exports = {
  TOOL_PERMISSIONS,
  buildToolContext,
  canUseAITool,
  hasToolPermission
};
