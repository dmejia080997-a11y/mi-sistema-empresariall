function registerMasterActivitiesRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/master/activities', requireMaster, (req, res) => {
  db.all(
    'SELECT code, name FROM permission_modules WHERE is_active = 1 ORDER BY name',
    (modErr, modules) => {
      const safeModules = modErr ? [] : modules;
      const moduleMap = new Map(safeModules.map((m) => [m.code, m.name]));
      db.all(
        'SELECT id, name, modules_json, created_at FROM business_activities ORDER BY name',
        (actErr, activities) => {
          const safeActivities = (actErr ? [] : activities).map((row) => ({
            id: row.id,
            name: row.name,
            created_at: row.created_at,
            modules: parseJsonList(row.modules_json),
            module_labels: parseJsonList(row.modules_json).map((code) => moduleMap.get(code) || code)
          }));
          res.render('master-activities', {
            modules: safeModules,
            activities: safeActivities,
            flash: res.locals.flash
          });
        }
      );
    }
  );
});

app.post('/master/activities/create', requireMaster, (req, res) => {
  const name = normalizeString(req.body.name);
  db.all(
    'SELECT code FROM permission_modules WHERE is_active = 1 ORDER BY name',
    (modErr, modules) => {
      const allowedSet = new Set((modErr ? [] : modules).map((m) => m.code));
      const selected = normalizeModuleSelection(req.body.modules, allowedSet);
      if (!name) {
        setFlash(req, 'error', 'El nombre de la actividad es obligatorio.');
        return res.redirect('/master/activities');
      }
      if (!selected.length) {
        setFlash(req, 'error', 'Selecciona al menos un modulo para la actividad.');
        return res.redirect('/master/activities');
      }
      db.run(
        'INSERT INTO business_activities (name, modules_json) VALUES (?, ?)',
        [name, JSON.stringify(selected)],
        (err) => {
          if (err) {
            const message = String(err || '');
            if (message.includes('UNIQUE')) {
              setFlash(req, 'error', 'Ya existe una actividad con ese nombre.');
            } else {
              setFlash(req, 'error', 'No se pudo crear la actividad.');
            }
            return res.redirect('/master/activities');
          }
          setFlash(req, 'success', 'Actividad creada correctamente.');
          return res.redirect('/master/activities');
        }
      );
    }
  );
});

app.post('/master/activities/:id/update', requireMaster, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.redirect('/master/activities');
  }
  const name = normalizeString(req.body.name);
  db.all(
    'SELECT code FROM permission_modules WHERE is_active = 1 ORDER BY name',
    (modErr, modules) => {
      const allowedSet = new Set((modErr ? [] : modules).map((m) => m.code));
      const selected = normalizeModuleSelection(req.body.modules, allowedSet);
      if (!name) {
        setFlash(req, 'error', 'El nombre de la actividad es obligatorio.');
        return res.redirect('/master/activities');
      }
      if (!selected.length) {
        setFlash(req, 'error', 'Selecciona al menos un modulo para la actividad.');
        return res.redirect('/master/activities');
      }
      db.run(
        'UPDATE business_activities SET name = ?, modules_json = ? WHERE id = ?',
        [name, JSON.stringify(selected), id],
        (err) => {
          if (err) {
            const message = String(err || '');
            if (message.includes('UNIQUE')) {
              setFlash(req, 'error', 'Ya existe una actividad con ese nombre.');
            } else {
              setFlash(req, 'error', 'No se pudo actualizar la actividad.');
            }
            return res.redirect('/master/activities');
          }
          setFlash(req, 'success', 'Actividad actualizada.');
          return res.redirect('/master/activities');
        }
      );
    }
  );
});

app.post('/master/activities/:id/delete', requireMaster, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.redirect('/master/activities');
  }
  db.run('DELETE FROM business_activities WHERE id = ?', [id], (err) => {
    if (err) {
      setFlash(req, 'error', 'No se pudo eliminar la actividad.');
      return res.redirect('/master/activities');
    }
    setFlash(req, 'success', 'Actividad eliminada.');
    return res.redirect('/master/activities');
  });
});

  }
}

module.exports = {
  registerMasterActivitiesRoutes
};
