const fs = require('fs');
const path = require('path');
const { hasToolPermission } = require('./permissions');

function loadTools(toolsDir = path.join(__dirname, 'tools')) {
  const registry = new Map();
  if (!fs.existsSync(toolsDir)) return registry;
  fs.readdirSync(toolsDir)
    .filter((file) => file.endsWith('.tools.js'))
    .sort()
    .forEach((file) => {
      try {
        const toolPath = path.join(toolsDir, file);
        delete require.cache[require.resolve(toolPath)];
        const mod = require(toolPath);
        const tools = Array.isArray(mod) ? mod : Object.values(mod || {});
        tools.forEach((tool) => {
          if (!tool || !tool.name) return;
          const runner = typeof tool.handler === 'function' ? tool.handler : tool.execute;
          if (typeof runner !== 'function') return;
          registry.set(tool.name, {
            ...tool,
            execute: async (args, context) => {
              try {
                return await runner(args || {}, context);
              } catch (err) {
                if (/no such table|no such column|SQLITE_ERROR/i.test(String(err && err.message ? err.message : err))) {
                  return { message: 'El modulo todavia no tiene datos disponibles o la tabla no existe.' };
                }
                throw err;
              }
            }
          });
        });
      } catch (err) {
        console.error(`[ai/toolRegistry] No se pudo cargar ${file}`, err);
      }
    });
  return registry;
}

function getToolDefinitions(context) {
  return Array.from(loadTools().values())
    .filter((tool) => hasToolPermission(context, tool))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false }
      }
    }));
}

function getTool(name) {
  return loadTools().get(name) || null;
}

module.exports = {
  getTool,
  getToolDefinitions,
  loadTools
};
