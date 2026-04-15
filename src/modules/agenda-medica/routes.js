function registerAgendaMedicaRoutes(app, deps) {
  const scope = { app, ...deps };
  with (scope) {
app.get('/agenda-medica', requireAuth, requirePermission('agenda_medica', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  if (!companyId) return res.redirect('/dashboard');
  db.all(
    'SELECT id, name FROM doctors WHERE company_id = ? AND is_active = 1 ORDER BY name',
    [companyId],
    (err, rows) => {
      const doctors = (err || !rows ? [] : rows).map((row) => ({
        id: row.id,
        name: row.name || `Doctor #${row.id}`
      }));
      getCompanyBrandById(companyId, (companyBrand) => {
        res.render('agenda-medica', {
          doctors,
          statuses: APPOINTMENT_STATUSES,
          companyBrand
        });
      });
    }
  );
});

app.get('/agenda-medica/api/appointments', requireAuth, requirePermission('agenda_medica', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const doctorId = req.query.doctor_id ? Number(req.query.doctor_id) : null;
  const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!isIsoDate(start) || !isIsoDate(end)) {
    return res.status(400).json({ ok: false, message: 'Rango invalido.' });
  }
  const params = [companyId, start, end];
  let doctorClause = '';
  if (Number.isInteger(doctorId) && doctorId > 0) {
    doctorClause = ' AND a.doctor_id = ?';
    params.push(doctorId);
  }
  db.all(
    `SELECT a.*, d.name AS doctor_name
     FROM appointments a
     LEFT JOIN doctors d ON d.id = a.doctor_id
     WHERE a.company_id = ?
       AND date(a.fecha_hora) BETWEEN date(?) AND date(?)
       ${doctorClause}
     ORDER BY a.fecha_hora ASC`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, message: 'Error al cargar.' });
      return res.json({ ok: true, appointments: rows || [] });
    }
  );
});

app.post('/agenda-medica/api/appointments', requireAuth, requirePermission('agenda_medica', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const pacienteNombre = String(req.body.paciente_nombre || '').trim();
  const telefono = String(req.body.telefono || '').trim();
  const motivo = String(req.body.motivo || '').trim();
  const doctorId = Number(req.body.doctor_id);
  const fechaHora = String(req.body.fecha_hora || '').trim();
  const estado = String(req.body.estado || '').trim();
  const durationMin = Number(req.body.duration_min || APPOINTMENT_DEFAULT_DURATION);

  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!pacienteNombre || !Number.isInteger(doctorId) || doctorId <= 0 || !fechaHora || !APPOINTMENT_STATUSES.includes(estado)) {
    return res.status(400).json({ ok: false, message: 'Datos incompletos.' });
  }
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    return res.status(400).json({ ok: false, message: 'Duracion invalida.' });
  }

  db.get(
    'SELECT id FROM doctors WHERE id = ? AND company_id = ?',
    [doctorId, companyId],
    (docErr, docRow) => {
      if (docErr || !docRow) {
        return res.status(400).json({ ok: false, message: 'Doctor invalido.' });
      }
      db.run(
        `INSERT INTO appointments (company_id, paciente_nombre, telefono, motivo, doctor_id, fecha_hora, estado, duration_min)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyId, pacienteNombre, telefono || null, motivo || null, doctorId, fechaHora, estado, Math.round(durationMin)],
        function (err) {
          if (err) return res.status(500).json({ ok: false, message: 'Error al crear.' });
          return res.json({ ok: true, id: this.lastID });
        }
      );
    }
  );
});

app.put('/agenda-medica/api/appointments/:id', requireAuth, requirePermission('agenda_medica', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const pacienteNombre = String(req.body.paciente_nombre || '').trim();
  const telefono = String(req.body.telefono || '').trim();
  const motivo = String(req.body.motivo || '').trim();
  const doctorId = Number(req.body.doctor_id);
  const fechaHora = String(req.body.fecha_hora || '').trim();
  const estado = String(req.body.estado || '').trim();
  const durationMin = Number(req.body.duration_min || APPOINTMENT_DEFAULT_DURATION);

  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'ID invalido.' });
  }
  if (!pacienteNombre || !Number.isInteger(doctorId) || doctorId <= 0 || !fechaHora || !APPOINTMENT_STATUSES.includes(estado)) {
    return res.status(400).json({ ok: false, message: 'Datos incompletos.' });
  }
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    return res.status(400).json({ ok: false, message: 'Duracion invalida.' });
  }

  db.get(
    'SELECT id FROM doctors WHERE id = ? AND company_id = ?',
    [doctorId, companyId],
    (docErr, docRow) => {
      if (docErr || !docRow) {
        return res.status(400).json({ ok: false, message: 'Doctor invalido.' });
      }
      db.run(
        `UPDATE appointments
         SET paciente_nombre = ?, telefono = ?, motivo = ?, doctor_id = ?, fecha_hora = ?, estado = ?, duration_min = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND company_id = ?`,
        [pacienteNombre, telefono || null, motivo || null, doctorId, fechaHora, estado, Math.round(durationMin), id, companyId],
        (err) => {
          if (err) return res.status(500).json({ ok: false, message: 'Error al actualizar.' });
          return res.json({ ok: true });
        }
      );
    }
  );
});

app.delete('/agenda-medica/api/appointments/:id', requireAuth, requirePermission('agenda_medica', 'delete'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'ID invalido.' });
  }
  db.run(
    'DELETE FROM appointments WHERE id = ? AND company_id = ?',
    [id, companyId],
    (err) => {
      if (err) return res.status(500).json({ ok: false, message: 'Error al eliminar.' });
      return res.json({ ok: true });
    }
  );
});

app.get('/agenda-medica/api/doctors', requireAuth, requirePermission('agenda_medica', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  db.all(
    `SELECT id, name, phone, specialty, is_active
     FROM doctors
     WHERE company_id = ?
     ORDER BY name`,
    [companyId],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, message: 'Error al cargar.' });
      return res.json({ ok: true, doctors: rows || [] });
    }
  );
});

app.post('/agenda-medica/api/doctors', requireAuth, requirePermission('agenda_medica', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const specialty = String(req.body.specialty || '').trim();
  const isActive = req.body.is_active ? 1 : 0;
  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!name) return res.status(400).json({ ok: false, message: 'Nombre requerido.' });
  db.run(
    `INSERT INTO doctors (company_id, name, phone, specialty, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [companyId, name, phone || null, specialty || null, isActive],
    function (err) {
      if (err) return res.status(500).json({ ok: false, message: 'Error al crear.' });
      return res.json({ ok: true, id: this.lastID });
    }
  );
});

app.put('/agenda-medica/api/doctors/:id', requireAuth, requirePermission('agenda_medica', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const specialty = String(req.body.specialty || '').trim();
  const isActive = req.body.is_active ? 1 : 0;
  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'ID invalido.' });
  }
  if (!name) return res.status(400).json({ ok: false, message: 'Nombre requerido.' });
  db.run(
    `UPDATE doctors
     SET name = ?, phone = ?, specialty = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [name, phone || null, specialty || null, isActive, id, companyId],
    (err) => {
      if (err) return res.status(500).json({ ok: false, message: 'Error al actualizar.' });
      return res.json({ ok: true });
    }
  );
});

app.delete('/agenda-medica/api/doctors/:id', requireAuth, requirePermission('agenda_medica', 'delete'), (req, res) => {
  const companyId = getCompanyId(req);
  const id = Number(req.params.id);
  if (!companyId) return res.status(403).json({ ok: false, message: 'Empresa no valida.' });
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'ID invalido.' });
  }
  db.get(
    'SELECT COUNT(1) AS total FROM appointments WHERE company_id = ? AND doctor_id = ?',
    [companyId, id],
    (countErr, row) => {
      if (countErr) return res.status(500).json({ ok: false, message: 'Error al validar.' });
      if (row && Number(row.total || 0) > 0) {
        return res.status(409).json({ ok: false, message: 'Doctor con citas asignadas.' });
      }
      db.run(
        'DELETE FROM doctors WHERE id = ? AND company_id = ?',
        [id, companyId],
        (err) => {
          if (err) return res.status(500).json({ ok: false, message: 'Error al eliminar.' });
          return res.json({ ok: true });
        }
      );
    }
  );
});

  }
}

module.exports = {
  registerAgendaMedicaRoutes
};
