const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');

const HR_TABS = [
  { key: 'employees', label: 'Ficha de empleado' },
  { key: 'contracts', label: 'Contratos' },
  { key: 'salaries', label: 'Salarios' },
  { key: 'overtime', label: 'Horas extras' },
  { key: 'attendance', label: 'Asistencia' },
  { key: 'warnings', label: 'Llamadas de atención' },
  { key: 'orgchart', label: 'Organigramas' },
  { key: 'descriptions', label: 'Descripciones' },
  { key: 'permissions', label: 'Permisos' },
  { key: 'vacations', label: 'Vacaciones' }
];

const HR_TAB_SET = new Set(HR_TABS.map((tab) => tab.key));
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_ATTENDANCE_MONTH = 8;
const VACATION_DAYS_PER_YEAR = 15;
const LATE_THRESHOLD = '08:15';
const PRINTABLE_TABS = new Set(['warnings', 'descriptions', 'permissions']);
const EMPLOYEE_ATTACHMENT_LABELS = {
  dpi_front: 'DPI frente',
  dpi_back: 'DPI reverso',
  signed_contract: 'Contrato firmado',
  other_document: 'Otro documento'
};

let isHrInitialized = false;

function isDuplicateColumnError(err) {
  if (!err || !err.message) return false;
  const message = String(err.message).toLowerCase();
  return message.includes('duplicate column') || message.includes('already exists');
}

function escapeSqlIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return normalized;
}

function registerHrRoutes(app, deps) {
  const {
    db,
    requireAuth,
    requirePermission,
    csrfMiddleware,
    getCompanyId,
    normalizeString,
    setFlash,
    buildFileUrl
  } = deps;

  initializeHrModule(db);

  const uploadRoot = path.resolve(path.join(__dirname, '..', '..', '..', 'data', 'uploads', 'rrhh'));
  ensureDir(uploadRoot);

  const uploadDirs = {
    employeePhotos: path.join(uploadRoot, 'employees', 'photos'),
    employeeApplications: path.join(uploadRoot, 'employees', 'applications'),
    employeeAttachments: path.join(uploadRoot, 'employees', 'attachments'),
    warningAttachments: path.join(uploadRoot, 'warnings'),
    permissionAttachments: path.join(uploadRoot, 'permissions'),
    contractPdfs: path.join(uploadRoot, 'contracts', 'pdf')
  };

  Object.values(uploadDirs).forEach(ensureDir);

  const rrhhUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        if (file.fieldname === 'photo') return cb(null, uploadDirs.employeePhotos);
        if (file.fieldname === 'job_application') return cb(null, uploadDirs.employeeApplications);
        if (['dpi_front', 'dpi_back', 'signed_contract', 'other_documents'].includes(file.fieldname)) {
          return cb(null, uploadDirs.employeeAttachments);
        }
        if (file.fieldname === 'attachment') {
          const section = detectAttachmentSection(req.originalUrl);
          return cb(null, section === 'permissions' ? uploadDirs.permissionAttachments : uploadDirs.warningAttachments);
        }
        return cb(null, uploadRoot);
      },
      filename: (req, file, cb) => {
        const ext = safeExtension(file.originalname);
        const token = crypto.randomBytes(8).toString('hex');
        cb(null, `${Date.now()}-${token}${ext}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.fieldname === 'photo') {
        return cb(null, Boolean(file.mimetype && file.mimetype.startsWith('image/')));
      }
      return cb(null, isAllowedDocument(file));
    }
  });

  const employeeUpload = rrhhUpload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'job_application', maxCount: 1 },
    { name: 'dpi_front', maxCount: 1 },
    { name: 'dpi_back', maxCount: 1 },
    { name: 'signed_contract', maxCount: 1 },
    { name: 'other_documents', maxCount: 6 }
  ]);
  const singleAttachmentUpload = rrhhUpload.single('attachment');

  const dbGet = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });

  const dbAll = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

  const dbRun = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) return reject(err);
        return resolve({ lastID: this.lastID, changes: this.changes });
      });
    });

  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  async function ensureEmployee(companyId, employeeId) {
    const employee = await dbGet(
      `SELECT e.*,
              boss.first_name || ' ' || boss.last_name AS immediate_boss_name,
              jd.position_name AS description_position_name
       FROM hr_employees e
       LEFT JOIN hr_employees boss ON boss.id = e.immediate_boss_id AND boss.company_id = e.company_id
       LEFT JOIN hr_job_descriptions jd ON jd.id = e.job_description_id AND jd.company_id = e.company_id
       WHERE e.id = ? AND e.company_id = ?`,
      [employeeId, companyId]
    );
    return employee || null;
  }

  async function ensureDescription(companyId, descriptionId) {
    if (!descriptionId) return null;
    return dbGet('SELECT * FROM hr_job_descriptions WHERE id = ? AND company_id = ?', [descriptionId, companyId]);
  }

  async function ensureRecordById(table, companyId, id) {
    if (!Number.isInteger(id) || id <= 0) return null;
    return dbGet(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, [id, companyId]);
  }

  async function getEmployeeOptions(companyId) {
    return dbAll(
      `SELECT e.id,
              e.first_name,
              e.last_name,
              e.dpi_number,
              e.address,
              e.position,
              e.department,
              e.hire_date,
              e.salary_base,
              e.bonus_amount,
              e.photo_path,
              boss.first_name || ' ' || boss.last_name AS immediate_boss_name
       FROM hr_employees e
       LEFT JOIN hr_employees boss ON boss.id = e.immediate_boss_id AND boss.company_id = e.company_id
       WHERE e.company_id = ?
       ORDER BY e.first_name, e.last_name`,
      [companyId]
    );
  }

  async function getJobDescriptionOptions(companyId) {
    return dbAll(
      `SELECT id, position_name, department, status
       FROM hr_job_descriptions
       WHERE company_id = ?
       ORDER BY position_name, department`,
      [companyId]
    );
  }

  async function getDepartmentOptions(companyId) {
    const rows = await dbAll(
      `SELECT DISTINCT department
       FROM hr_employees
       WHERE company_id = ? AND department IS NOT NULL AND TRIM(department) <> ''
       ORDER BY department`,
      [companyId]
    );
    return rows.map((row) => row.department);
  }

  async function getHrSummary(companyId) {
    const [employeeTotals, contractTotals, attendanceTotals, vacationTotals] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_total
         FROM hr_employees
         WHERE company_id = ?`,
        [companyId]
      ),
      dbGet(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'Vigente' THEN 1 ELSE 0 END) AS active_total
         FROM hr_contracts
         WHERE company_id = ?`,
        [companyId]
      ),
      dbGet(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN attendance_status = 'Tarde' THEN 1 ELSE 0 END) AS late_total
         FROM hr_attendance
         WHERE company_id = ?`,
        [companyId]
      ),
      dbGet(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'Aprobada' THEN 1 ELSE 0 END) AS approved_total
         FROM hr_vacations
         WHERE company_id = ?`,
        [companyId]
      )
    ]);

    return {
      employeeTotal: Number(employeeTotals && employeeTotals.total) || 0,
      activeEmployeeTotal: Number(employeeTotals && employeeTotals.active_total) || 0,
      contractTotal: Number(contractTotals && contractTotals.total) || 0,
      activeContractTotal: Number(contractTotals && contractTotals.active_total) || 0,
      attendanceTotal: Number(attendanceTotals && attendanceTotals.total) || 0,
      lateAttendanceTotal: Number(attendanceTotals && attendanceTotals.late_total) || 0,
      vacationTotal: Number(vacationTotals && vacationTotals.total) || 0,
      approvedVacationTotal: Number(vacationTotals && vacationTotals.approved_total) || 0
    };
  }

  async function listEmployees(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const view = normalizeEmployeeView(query.view);
    const filters = {
      q: normalizeString(query.q),
      department: normalizeString(query.department),
      status: normalizeString(query.status)
    };
    const params = [companyId];
    const where = ['e.company_id = ?'];
    if (filters.q) {
      where.push(`(
        e.first_name LIKE ? OR
        e.last_name LIKE ? OR
        e.employee_code LIKE ? OR
        e.position LIKE ? OR
        e.department LIKE ? OR
        e.dpi_number LIKE ?
      )`);
      params.push(
        `%${filters.q}%`,
        `%${filters.q}%`,
        `%${filters.q}%`,
        `%${filters.q}%`,
        `%${filters.q}%`,
        `%${filters.q}%`
      );
    }
    if (filters.department) {
      where.push('e.department = ?');
      params.push(filters.department);
    }
    if (filters.status === 'Activos') {
      where.push('e.is_active = 1');
    } else if (filters.status === 'Inactivos') {
      where.push('e.is_active = 0');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await dbGet(`SELECT COUNT(*) AS total FROM hr_employees e ${whereSql}`, params);
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT e.*,
              boss.first_name || ' ' || boss.last_name AS immediate_boss_name,
              jd.position_name AS description_position_name
       FROM hr_employees e
       LEFT JOIN hr_employees boss ON boss.id = e.immediate_boss_id AND boss.company_id = e.company_id
       LEFT JOIN hr_job_descriptions jd ON jd.id = e.job_description_id AND jd.company_id = e.company_id
       ${whereSql}
       ORDER BY e.first_name, e.last_name
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );

    return {
      rows: rows.map((row) => ({
        ...row,
        full_name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        photo_url: buildFileUrl(row.photo_path || null),
        detail_url: `/rrhh/employees/${row.id}`,
        print_url: `/rrhh/employees/${row.id}/print`
      })),
      filters,
      pagination,
      view
    };
  }

  async function listContracts(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      status: normalizeString(query.status),
      q: normalizeString(query.q)
    };
    const params = [companyId];
    const where = ['c.company_id = ?'];
    if (filters.employee_id) {
      where.push('c.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.status) {
      where.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.q) {
      where.push(`(
        e.first_name LIKE ? OR
        e.last_name LIKE ? OR
        c.contract_type LIKE ? OR
        c.workplace LIKE ?
      )`);
      params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_contracts c
       JOIN hr_employees e ON e.id = c.employee_id AND e.company_id = c.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT c.*,
              e.first_name || ' ' || e.last_name AS employee_name,
              e.position AS employee_position,
              e.department AS employee_department
       FROM hr_contracts c
       JOIN hr_employees e ON e.id = c.employee_id AND e.company_id = c.company_id
       ${whereSql}
       ORDER BY c.start_date DESC, c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    return { rows, filters, pagination };
  }

  async function listSalaries(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      from: normalizeString(query.from),
      to: normalizeString(query.to)
    };
    const params = [companyId];
    const where = ['s.company_id = ?'];
    if (filters.employee_id) {
      where.push('s.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.from) {
      where.push('s.effective_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('s.effective_date <= ?');
      params.push(filters.to);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_salaries s
       JOIN hr_employees e ON e.id = s.employee_id AND e.company_id = s.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT s.*,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM hr_salaries s
       JOIN hr_employees e ON e.id = s.employee_id AND e.company_id = s.company_id
       ${whereSql}
       ORDER BY s.effective_date DESC, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    const currentSalary = rows[0] || null;
    return {
      rows,
      filters,
      pagination,
      summary: {
        currentSalary: currentSalary ? toMoney(currentSalary.salary_base) : null,
        currentBonus: currentSalary ? toMoney(currentSalary.bonus_amount) : null
      }
    };
  }

  async function listOvertime(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      status: normalizeString(query.status),
      month: normalizeMonth(query.month)
    };
    const params = [companyId];
    const where = ['o.company_id = ?'];
    if (filters.employee_id) {
      where.push('o.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.status) {
      where.push('o.status = ?');
      params.push(filters.status);
    }
    if (filters.month) {
      where.push("substr(o.overtime_date, 1, 7) = ?");
      params.push(filters.month);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_overtime o
       JOIN hr_employees e ON e.id = o.employee_id AND e.company_id = o.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT o.*,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM hr_overtime o
       JOIN hr_employees e ON e.id = o.employee_id AND e.company_id = o.company_id
       ${whereSql}
       ORDER BY o.overtime_date DESC, o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    const monthRows = filters.month
      ? await dbAll(
          `SELECT total_hours
           FROM hr_overtime
           WHERE company_id = ? AND substr(overtime_date, 1, 7) = ?`,
          [companyId, filters.month]
        )
      : rows;
    const monthlyHours = monthRows.reduce((sum, row) => sum + Number(row.total_hours || 0), 0);
    return {
      rows,
      filters,
      pagination,
      summary: {
        monthlyHours: monthlyHours.toFixed(2)
      }
    };
  }

  async function listAttendance(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      status: normalizeString(query.status),
      month: normalizeMonth(query.month) || formatMonth(new Date())
    };
    const params = [companyId];
    const where = ['a.company_id = ?'];
    if (filters.employee_id) {
      where.push('a.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.status) {
      where.push('a.attendance_status = ?');
      params.push(filters.status);
    }
    if (filters.month) {
      where.push("substr(a.attendance_date, 1, 7) = ?");
      params.push(filters.month);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_attendance a
       JOIN hr_employees e ON e.id = a.employee_id AND e.company_id = a.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT a.*,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM hr_attendance a
       JOIN hr_employees e ON e.id = a.employee_id AND e.company_id = a.company_id
       ${whereSql}
       ORDER BY a.attendance_date DESC, a.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    const monthRows = await dbAll(
      `SELECT attendance_date, attendance_status, check_in, lunch_out, lunch_in, check_out
       FROM hr_attendance
       WHERE company_id = ? AND substr(attendance_date, 1, 7) = ?`,
      [companyId, filters.month]
    );
    const lateCount = monthRows.filter((row) => isLateCheckIn(row.check_in)).length;
    const totalWorkedHours = monthRows.reduce(
      (sum, row) => sum + calculateWorkedHours(row.check_in, row.lunch_out, row.lunch_in, row.check_out),
      0
    );
    const calendar = buildAttendanceCalendar(filters.month, monthRows);
    return {
      rows: rows.map((row) => ({
        ...row,
        worked_hours: calculateWorkedHours(row.check_in, row.lunch_out, row.lunch_in, row.check_out).toFixed(2)
      })),
      filters,
      pagination,
      calendar,
      summary: {
        lateCount,
        totalWorkedHours: totalWorkedHours.toFixed(2)
      }
    };
  }

  async function listWarnings(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      status: normalizeString(query.status)
    };
    const params = [companyId];
    const where = ['w.company_id = ?'];
    if (filters.employee_id) {
      where.push('w.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.status) {
      where.push('w.status = ?');
      params.push(filters.status);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_warnings w
       JOIN hr_employees e ON e.id = w.employee_id AND e.company_id = w.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT w.*,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM hr_warnings w
       JOIN hr_employees e ON e.id = w.employee_id AND e.company_id = w.company_id
       ${whereSql}
       ORDER BY w.warning_date DESC, w.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    return {
      rows: rows.map((row) => ({
        ...row,
        attachment_url: buildFileUrl(row.attachment_path || null)
      })),
      filters,
      pagination
    };
  }

  async function listDescriptions(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      department: normalizeString(query.department),
      status: normalizeString(query.status)
    };
    const params = [companyId];
    const where = ['d.company_id = ?'];
    if (filters.department) {
      where.push('d.department = ?');
      params.push(filters.department);
    }
    if (filters.status) {
      where.push('d.status = ?');
      params.push(filters.status);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(`SELECT COUNT(*) AS total FROM hr_job_descriptions d ${whereSql}`, params);
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT d.*,
              COUNT(e.id) AS assigned_employees
       FROM hr_job_descriptions d
       LEFT JOIN hr_employees e ON e.job_description_id = d.id AND e.company_id = d.company_id
       ${whereSql}
       GROUP BY d.id
       ORDER BY d.position_name, d.department
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    return { rows, filters, pagination };
  }

  async function listPermissions(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      status: normalizeString(query.status)
    };
    const params = [companyId];
    const where = ['p.company_id = ?'];
    if (filters.employee_id) {
      where.push('p.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.status) {
      where.push('p.status = ?');
      params.push(filters.status);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_permissions p
       JOIN hr_employees e ON e.id = p.employee_id AND e.company_id = p.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT p.*,
              e.first_name || ' ' || e.last_name AS employee_name
       FROM hr_permissions p
       JOIN hr_employees e ON e.id = p.employee_id AND e.company_id = p.company_id
       ${whereSql}
       ORDER BY p.start_date DESC, p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    return {
      rows: rows.map((row) => ({
        ...row,
        attachment_url: buildFileUrl(row.attachment_path || null)
      })),
      filters,
      pagination
    };
  }

  async function listVacations(companyId, query) {
    const page = parsePositiveInt(query.page, 1);
    const filters = {
      employee_id: parsePositiveInt(query.employee_id, null),
      department: normalizeString(query.department),
      status: normalizeString(query.status),
      month: normalizeMonth(query.month)
    };
    const params = [companyId];
    const where = ['v.company_id = ?'];
    if (filters.employee_id) {
      where.push('v.employee_id = ?');
      params.push(filters.employee_id);
    }
    if (filters.department) {
      where.push('e.department = ?');
      params.push(filters.department);
    }
    if (filters.status) {
      where.push('v.status = ?');
      params.push(filters.status);
    }
    if (filters.month) {
      where.push("substr(v.vacation_start, 1, 7) = ?");
      params.push(filters.month);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRow = await dbGet(
      `SELECT COUNT(*) AS total
       FROM hr_vacations v
       JOIN hr_employees e ON e.id = v.employee_id AND e.company_id = v.company_id
       ${whereSql}`,
      params
    );
    const pagination = buildPagination(page, Number(countRow && countRow.total) || 0, DEFAULT_PAGE_SIZE);
    const rows = await dbAll(
      `SELECT v.*,
              e.first_name || ' ' || e.last_name AS employee_name,
              e.department
       FROM hr_vacations v
       JOIN hr_employees e ON e.id = v.employee_id AND e.company_id = v.company_id
       ${whereSql}
       ORDER BY v.vacation_start DESC, v.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.pageSize, pagination.offset]
    );
    const byDepartment = rows.reduce((acc, row) => {
      const key = row.department || 'Sin departamento';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      rows,
      filters,
      pagination,
      summary: {
        byDepartment: Object.entries(byDepartment).map(([department, total]) => ({ department, total }))
      }
    };
  }

  async function buildOrgChart(companyId, query) {
    const department = normalizeString(query.department);
    const params = [companyId];
    let sql =
      `SELECT e.id,
              e.first_name,
              e.last_name,
              e.position,
              e.department,
              e.immediate_boss_id,
              e.photo_path,
              e.is_active
       FROM hr_employees e
       WHERE e.company_id = ?`;
    if (department) {
      sql += ' AND e.department = ?';
      params.push(department);
    }
    sql += ' ORDER BY e.department, e.position, e.first_name, e.last_name';
    const rows = await dbAll(sql, params);
    const nodes = rows.map((row) => ({
      ...row,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      photo_url: buildFileUrl(row.photo_path || null)
    }));
    const byBoss = new Map();
    nodes.forEach((node) => {
      const key = node.immediate_boss_id || 0;
      if (!byBoss.has(key)) byBoss.set(key, []);
      byBoss.get(key).push(node);
    });
    return {
      department,
      trees: buildOrgNodes(byBoss, 0, 0)
    };
  }

  async function getTabRecord(companyId, tab, editId) {
    const id = parsePositiveInt(editId, null);
    if (!id) return null;
    if (tab === 'salaries') return ensureRecordById('hr_salaries', companyId, id);
    if (tab === 'overtime') return ensureRecordById('hr_overtime', companyId, id);
    if (tab === 'attendance') return ensureRecordById('hr_attendance', companyId, id);
    if (tab === 'warnings') return ensureRecordById('hr_warnings', companyId, id);
    if (tab === 'descriptions') return ensureRecordById('hr_job_descriptions', companyId, id);
    if (tab === 'permissions') return ensureRecordById('hr_permissions', companyId, id);
    if (tab === 'vacations') return ensureRecordById('hr_vacations', companyId, id);
    return null;
  }

  async function renderHrHome(req, res) {
    const companyId = getCompanyId(req);
    const activeTab = normalizeHrTab(req.query.tab);
    const summary = await getHrSummary(companyId);
    const employees = await getEmployeeOptions(companyId);
    const departments = await getDepartmentOptions(companyId);
    const descriptions = await getJobDescriptionOptions(companyId);
    const editRecord = await getTabRecord(companyId, activeTab, req.query.editId);

    const tabPayload = {};
    if (activeTab === 'employees') tabPayload.employees = await listEmployees(companyId, req.query);
    if (activeTab === 'contracts') tabPayload.contracts = await listContracts(companyId, req.query);
    if (activeTab === 'salaries') tabPayload.salaries = await listSalaries(companyId, req.query);
    if (activeTab === 'overtime') tabPayload.overtime = await listOvertime(companyId, req.query);
    if (activeTab === 'attendance') tabPayload.attendance = await listAttendance(companyId, req.query);
    if (activeTab === 'warnings') tabPayload.warnings = await listWarnings(companyId, req.query);
    if (activeTab === 'orgchart') tabPayload.orgchart = await buildOrgChart(companyId, req.query);
    if (activeTab === 'descriptions') tabPayload.descriptions = await listDescriptions(companyId, req.query);
    if (activeTab === 'permissions') tabPayload.permissions = await listPermissions(companyId, req.query);
    if (activeTab === 'vacations') tabPayload.vacations = await listVacations(companyId, req.query);

    return res.render('rrhh/index', {
      hrTabs: HR_TABS,
      activeTab,
      query: req.query || {},
      summary,
      employees,
      departments,
      descriptions,
      editRecord,
      flash: res.locals.flash,
      buildFileUrl,
      ...tabPayload
    });
  }

  app.get('/rrhh', requireAuth, requirePermission('rrhh', 'view'), asyncHandler(renderHrHome));

  app.get('/rrhh/employees/new', requireAuth, requirePermission('rrhh', 'create'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const [employees, descriptions] = await Promise.all([
      getEmployeeOptions(companyId),
      getJobDescriptionOptions(companyId)
    ]);
    return res.render('rrhh/employee-form', {
      mode: 'create',
      employee: null,
      attachments: [],
      employees,
      descriptions,
      flash: res.locals.flash
    });
  }));

  app.get('/rrhh/employees/:id', requireAuth, requirePermission('rrhh', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const employeeId = parsePositiveInt(req.params.id, null);
    const employee = await ensureEmployee(companyId, employeeId);
    if (!employee) {
      setFlash(req, 'error', 'Empleado no encontrado.');
      return res.redirect('/rrhh?tab=employees');
    }
    const [attachments, contracts, salaries, warnings, permissions, vacations] = await Promise.all([
      dbAll(
        `SELECT *
         FROM hr_employee_attachments
         WHERE company_id = ? AND employee_id = ?
         ORDER BY created_at DESC, id DESC`,
        [companyId, employeeId]
      ),
      dbAll(
        `SELECT id, contract_type, start_date, end_date, status
         FROM hr_contracts
         WHERE company_id = ? AND employee_id = ?
         ORDER BY start_date DESC, id DESC`,
        [companyId, employeeId]
      ),
      dbAll(
        `SELECT effective_date, salary_base, bonus_amount, extra_bonus, fixed_deductions, payment_method, status
         FROM hr_salaries
         WHERE company_id = ? AND employee_id = ?
         ORDER BY effective_date DESC, id DESC
         LIMIT 8`,
        [companyId, employeeId]
      ),
      dbAll(
        `SELECT id, warning_date, warning_type, reason, status
         FROM hr_warnings
         WHERE company_id = ? AND employee_id = ?
         ORDER BY warning_date DESC, id DESC
         LIMIT 8`,
        [companyId, employeeId]
      ),
      dbAll(
        `SELECT id, permission_type, start_date, end_date, total_days, with_pay, status
         FROM hr_permissions
         WHERE company_id = ? AND employee_id = ?
         ORDER BY start_date DESC, id DESC
         LIMIT 8`,
        [companyId, employeeId]
      ),
      dbAll(
        `SELECT id, vacation_period, available_days, vacation_start, vacation_end, status
         FROM hr_vacations
         WHERE company_id = ? AND employee_id = ?
         ORDER BY vacation_start DESC, id DESC
         LIMIT 8`,
        [companyId, employeeId]
      )
    ]);

    return res.render('rrhh/employee-detail', {
      employee: {
        ...employee,
        full_name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
        photo_url: buildFileUrl(employee.photo_path || null),
        job_application_url: buildFileUrl(employee.job_application_path || null)
      },
      attachments: attachments.map((entry) => ({
        ...entry,
        attachment_label: EMPLOYEE_ATTACHMENT_LABELS[entry.attachment_type] || 'Documento',
        file_url: buildFileUrl(entry.file_path || null)
      })),
      contracts,
      salaries,
      warnings,
      permissions,
      vacations
    });
  }));

  app.get('/rrhh/employees/:id/edit', requireAuth, requirePermission('rrhh', 'edit'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const employeeId = parsePositiveInt(req.params.id, null);
    const employee = await ensureEmployee(companyId, employeeId);
    if (!employee) {
      setFlash(req, 'error', 'Empleado no encontrado.');
      return res.redirect('/rrhh?tab=employees');
    }
    const [attachments, employees, descriptions] = await Promise.all([
      dbAll(
        `SELECT *
         FROM hr_employee_attachments
         WHERE company_id = ? AND employee_id = ?
         ORDER BY created_at DESC, id DESC`,
        [companyId, employeeId]
      ),
      getEmployeeOptions(companyId),
      getJobDescriptionOptions(companyId)
    ]);
    return res.render('rrhh/employee-form', {
      mode: 'edit',
      employee: {
        ...employee,
        photo_url: buildFileUrl(employee.photo_path || null),
        job_application_url: buildFileUrl(employee.job_application_path || null)
      },
      attachments: attachments.map((entry) => ({
        ...entry,
        attachment_label: EMPLOYEE_ATTACHMENT_LABELS[entry.attachment_type] || 'Documento',
        file_url: buildFileUrl(entry.file_path || null)
      })),
      employees,
      descriptions,
      flash: res.locals.flash
    });
  }));

  app.post('/rrhh/employees/create', requireAuth, requirePermission('rrhh', 'create'), employeeUpload, csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildEmployeePayload(req, normalizeString);
    if (!payload.first_name || !payload.last_name || !payload.employee_code || !payload.hire_date) {
      setFlash(req, 'error', 'Completa nombre, código y fecha de ingreso del empleado.');
      return res.redirect('/rrhh/employees/new');
    }
    const duplicate = await dbGet(
      'SELECT id FROM hr_employees WHERE company_id = ? AND employee_code = ? LIMIT 1',
      [companyId, payload.employee_code]
    );
    if (duplicate) {
      setFlash(req, 'error', 'Ya existe un empleado con ese código interno.');
      return res.redirect('/rrhh/employees/new');
    }
    if (payload.immediate_boss_id) {
      const boss = await ensureEmployee(companyId, payload.immediate_boss_id);
      if (!boss) payload.immediate_boss_id = null;
    }
    if (payload.job_description_id) {
      const description = await ensureDescription(companyId, payload.job_description_id);
      if (!description) payload.job_description_id = null;
    }
    const photoFile = pickSingleFile(req.files, 'photo');
    const applicationFile = pickSingleFile(req.files, 'job_application');
    payload.photo_path = photoFile ? photoFile.path : null;
    payload.job_application_path = applicationFile ? applicationFile.path : null;

    const insert = await dbRun(
      `INSERT INTO hr_employees (
         company_id, first_name, last_name, dpi_number, dpi_issued_at, marital_status, married_last_name, gender,
         birth_date, phone, email, address, education_level, ethnicity, languages, position, department,
         immediate_boss_id, employee_code, hire_date, employment_status, contract_type, salary_base, bonus_amount,
         payroll_calculation_type, bank_account_number, bank_account_type, bank_name, photo_path, job_application_path,
         notes, job_description_id, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.first_name,
        payload.last_name,
        payload.dpi_number,
        payload.dpi_issued_at,
        payload.marital_status,
        payload.married_last_name,
        payload.gender,
        payload.birth_date,
        payload.phone,
        payload.email,
        payload.address,
        payload.education_level,
        payload.ethnicity,
        payload.languages,
        payload.position,
        payload.department,
        payload.immediate_boss_id,
        payload.employee_code,
        payload.hire_date,
        payload.employment_status,
        payload.contract_type,
        payload.salary_base,
        payload.bonus_amount,
        payload.payroll_calculation_type,
        payload.bank_account_number,
        payload.bank_account_type,
        payload.bank_name,
        payload.photo_path,
        payload.job_application_path,
        payload.notes,
        payload.job_description_id,
        payload.is_active
      ]
    );
    await insertEmployeeAttachments(dbRun, insert.lastID, companyId, req.files);
    setFlash(req, 'success', 'Empleado creado correctamente.');
    return res.redirect(`/rrhh/employees/${insert.lastID}`);
  }));

  app.post('/rrhh/employees/:id/update', requireAuth, requirePermission('rrhh', 'edit'), employeeUpload, csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const employeeId = parsePositiveInt(req.params.id, null);
    const existing = await ensureEmployee(companyId, employeeId);
    if (!existing) {
      setFlash(req, 'error', 'Empleado no encontrado.');
      return res.redirect('/rrhh?tab=employees');
    }
    const payload = buildEmployeePayload(req, normalizeString);
    if (!payload.first_name || !payload.last_name || !payload.employee_code || !payload.hire_date) {
      setFlash(req, 'error', 'Completa nombre, código y fecha de ingreso del empleado.');
      return res.redirect(`/rrhh/employees/${employeeId}/edit`);
    }
    const duplicate = await dbGet(
      'SELECT id FROM hr_employees WHERE company_id = ? AND employee_code = ? AND id != ? LIMIT 1',
      [companyId, payload.employee_code, employeeId]
    );
    if (duplicate) {
      setFlash(req, 'error', 'Ya existe otro empleado con ese código interno.');
      return res.redirect(`/rrhh/employees/${employeeId}/edit`);
    }
    if (payload.immediate_boss_id) {
      const boss = await ensureEmployee(companyId, payload.immediate_boss_id);
      if (!boss || boss.id === employeeId) payload.immediate_boss_id = null;
    }
    if (payload.job_description_id) {
      const description = await ensureDescription(companyId, payload.job_description_id);
      if (!description) payload.job_description_id = null;
    }
    const photoFile = pickSingleFile(req.files, 'photo');
    const applicationFile = pickSingleFile(req.files, 'job_application');
    payload.photo_path = photoFile ? photoFile.path : existing.photo_path;
    payload.job_application_path = applicationFile ? applicationFile.path : existing.job_application_path;

    await dbRun(
      `UPDATE hr_employees
       SET first_name = ?, last_name = ?, dpi_number = ?, dpi_issued_at = ?, marital_status = ?, married_last_name = ?,
           gender = ?, birth_date = ?, phone = ?, email = ?, address = ?, education_level = ?, ethnicity = ?, languages = ?,
           position = ?, department = ?, immediate_boss_id = ?, employee_code = ?, hire_date = ?, employment_status = ?,
           contract_type = ?, salary_base = ?, bonus_amount = ?, payroll_calculation_type = ?, bank_account_number = ?,
           bank_account_type = ?, bank_name = ?, photo_path = ?, job_application_path = ?, notes = ?, job_description_id = ?,
           is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.first_name,
        payload.last_name,
        payload.dpi_number,
        payload.dpi_issued_at,
        payload.marital_status,
        payload.married_last_name,
        payload.gender,
        payload.birth_date,
        payload.phone,
        payload.email,
        payload.address,
        payload.education_level,
        payload.ethnicity,
        payload.languages,
        payload.position,
        payload.department,
        payload.immediate_boss_id,
        payload.employee_code,
        payload.hire_date,
        payload.employment_status,
        payload.contract_type,
        payload.salary_base,
        payload.bonus_amount,
        payload.payroll_calculation_type,
        payload.bank_account_number,
        payload.bank_account_type,
        payload.bank_name,
        payload.photo_path,
        payload.job_application_path,
        payload.notes,
        payload.job_description_id,
        payload.is_active,
        employeeId,
        companyId
      ]
    );
    await insertEmployeeAttachments(dbRun, employeeId, companyId, req.files);
    setFlash(req, 'success', 'Empleado actualizado correctamente.');
    return res.redirect(`/rrhh/employees/${employeeId}`);
  }));

  app.post('/rrhh/employees/:id/toggle-status', requireAuth, requirePermission('rrhh', 'edit'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const employeeId = parsePositiveInt(req.params.id, null);
    const employee = await ensureEmployee(companyId, employeeId);
    if (!employee) {
      setFlash(req, 'error', 'Empleado no encontrado.');
      return res.redirect('/rrhh?tab=employees');
    }
    const nextActive = employee.is_active ? 0 : 1;
    const nextStatus = nextActive ? 'Activo' : 'Inactivo';
    await dbRun(
      `UPDATE hr_employees
       SET is_active = ?, employment_status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [nextActive, nextStatus, employeeId, companyId]
    );
    setFlash(req, 'success', nextActive ? 'Empleado reactivado.' : 'Empleado desactivado.');
    return res.redirect('/rrhh?tab=employees');
  }));

  app.get('/rrhh/employees/:id/print', requireAuth, requirePermission('rrhh', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const employeeId = parsePositiveInt(req.params.id, null);
    const employee = await ensureEmployee(companyId, employeeId);
    if (!employee) return res.redirect('/rrhh?tab=employees');
    const attachments = await dbAll(
      `SELECT attachment_type, file_path, original_name
       FROM hr_employee_attachments
       WHERE company_id = ? AND employee_id = ?
       ORDER BY created_at DESC`,
      [companyId, employeeId]
    );
    return res.render('rrhh/employee-print', {
      employee: {
        ...employee,
        full_name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
        photo_url: buildFileUrl(employee.photo_path || null),
        job_application_url: buildFileUrl(employee.job_application_path || null)
      },
      attachments: attachments.map((entry) => ({
        ...entry,
        attachment_label: EMPLOYEE_ATTACHMENT_LABELS[entry.attachment_type] || 'Documento',
        file_url: buildFileUrl(entry.file_path || null)
      }))
    });
  }));

  app.get('/rrhh/contracts/new', requireAuth, requirePermission('rrhh', 'create'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const employees = await getEmployeeOptions(companyId);
    return res.render('rrhh/contract-form', {
      mode: 'create',
      contract: null,
      employees,
      flash: res.locals.flash
    });
  }));

  app.get('/rrhh/contracts/:id/edit', requireAuth, requirePermission('rrhh', 'edit'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const contractId = parsePositiveInt(req.params.id, null);
    const contract = await dbGet('SELECT * FROM hr_contracts WHERE id = ? AND company_id = ?', [contractId, companyId]);
    if (!contract) {
      setFlash(req, 'error', 'Contrato no encontrado.');
      return res.redirect('/rrhh?tab=contracts');
    }
    const employees = await getEmployeeOptions(companyId);
    return res.render('rrhh/contract-form', {
      mode: 'edit',
      contract,
      employees,
      flash: res.locals.flash
    });
  }));

  app.post('/rrhh/contracts/create', requireAuth, requirePermission('rrhh', 'create'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildContractPayload(req, normalizeString);
    const employee = await ensureEmployee(companyId, payload.employee_id);
    if (!employee || !payload.contract_type || !payload.start_date) {
      setFlash(req, 'error', 'Selecciona empleado, tipo de contrato y fecha de inicio.');
      return res.redirect('/rrhh/contracts/new');
    }
    payload.generated_contract_text = normalizeString(req.body.generated_contract_text) || buildContractText(employee, payload);
    const insert = await dbRun(
      `INSERT INTO hr_contracts (
         company_id, employee_id, contract_type, start_date, end_date, work_schedule, workday_type, salary,
         bonus_amount, workplace, probation_period, main_functions, extra_clauses, observations,
         generated_contract_text, status, pdf_path, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.contract_type,
        payload.start_date,
        payload.end_date,
        payload.work_schedule,
        payload.workday_type,
        payload.salary,
        payload.bonus_amount,
        payload.workplace,
        payload.probation_period,
        payload.main_functions,
        payload.extra_clauses,
        payload.observations,
        payload.generated_contract_text,
        payload.status,
        null
      ]
    );
    setFlash(req, 'success', 'Contrato guardado correctamente.');
    return res.redirect(`/rrhh?tab=contracts&employee_id=${payload.employee_id}`);
  }));

  app.post('/rrhh/contracts/:id/update', requireAuth, requirePermission('rrhh', 'edit'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const contractId = parsePositiveInt(req.params.id, null);
    const existing = await dbGet('SELECT * FROM hr_contracts WHERE id = ? AND company_id = ?', [contractId, companyId]);
    if (!existing) {
      setFlash(req, 'error', 'Contrato no encontrado.');
      return res.redirect('/rrhh?tab=contracts');
    }
    const payload = buildContractPayload(req, normalizeString);
    const employee = await ensureEmployee(companyId, payload.employee_id);
    if (!employee || !payload.contract_type || !payload.start_date) {
      setFlash(req, 'error', 'Selecciona empleado, tipo de contrato y fecha de inicio.');
      return res.redirect(`/rrhh/contracts/${contractId}/edit`);
    }
    payload.generated_contract_text = normalizeString(req.body.generated_contract_text) || buildContractText(employee, payload);
    await dbRun(
      `UPDATE hr_contracts
       SET employee_id = ?, contract_type = ?, start_date = ?, end_date = ?, work_schedule = ?, workday_type = ?,
           salary = ?, bonus_amount = ?, workplace = ?, probation_period = ?, main_functions = ?, extra_clauses = ?,
           observations = ?, generated_contract_text = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.contract_type,
        payload.start_date,
        payload.end_date,
        payload.work_schedule,
        payload.workday_type,
        payload.salary,
        payload.bonus_amount,
        payload.workplace,
        payload.probation_period,
        payload.main_functions,
        payload.extra_clauses,
        payload.observations,
        payload.generated_contract_text,
        payload.status,
        contractId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Contrato actualizado correctamente.');
    return res.redirect(`/rrhh?tab=contracts&employee_id=${payload.employee_id}`);
  }));

  app.get('/rrhh/contracts/:id/print', requireAuth, requirePermission('rrhh', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const contractId = parsePositiveInt(req.params.id, null);
    const contract = await loadContractDetail(dbGet, companyId, contractId);
    if (!contract) return res.redirect('/rrhh?tab=contracts');
    return res.render('rrhh/contract-print', { contract });
  }));

  app.get('/rrhh/contracts/:id/export/pdf', requireAuth, requirePermission('rrhh', 'export'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const contractId = parsePositiveInt(req.params.id, null);
    const contract = await loadContractDetail(dbGet, companyId, contractId);
    if (!contract) return res.redirect('/rrhh?tab=contracts');

    const filePath = path.join(uploadDirs.contractPdfs, `contract-${companyId}-${contractId}.pdf`);
    await writeContractPdf(filePath, contract);
    await dbRun(
      'UPDATE hr_contracts SET pdf_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?',
      [filePath, contractId, companyId]
    );

    if (req.query.download === '1') {
      return res.download(filePath, `contrato-${contract.employee_name || contractId}.pdf`);
    }
    return res.sendFile(filePath);
  }));

  app.post('/rrhh/salaries/create', requireAuth, requirePermission('rrhh', 'create'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildSalaryPayload(req, normalizeString);
    const employee = await ensureEmployee(companyId, payload.employee_id);
    if (!employee || !payload.effective_date) {
      setFlash(req, 'error', 'Selecciona empleado y fecha efectiva.');
      return res.redirect('/rrhh?tab=salaries');
    }
    await dbRun(
      `INSERT INTO hr_salaries (
         company_id, employee_id, effective_date, salary_base, bonus_amount, extra_bonus, fixed_deductions,
         payment_method, bank_account_number, notes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.effective_date,
        payload.salary_base,
        payload.bonus_amount,
        payload.extra_bonus,
        payload.fixed_deductions,
        payload.payment_method,
        payload.bank_account_number,
        payload.notes,
        payload.status
      ]
    );
    await dbRun(
      `UPDATE hr_employees
       SET salary_base = ?, bonus_amount = ?, bank_account_number = COALESCE(NULLIF(?, ''), bank_account_number),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [payload.salary_base, payload.bonus_amount, payload.bank_account_number || '', payload.employee_id, companyId]
    );
    setFlash(req, 'success', 'Historial salarial actualizado.');
    return res.redirect('/rrhh?tab=salaries');
  }));

  app.post('/rrhh/salaries/:id/update', requireAuth, requirePermission('rrhh', 'edit'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const salaryId = parsePositiveInt(req.params.id, null);
    const existing = await ensureRecordById('hr_salaries', companyId, salaryId);
    if (!existing) {
      setFlash(req, 'error', 'Registro salarial no encontrado.');
      return res.redirect('/rrhh?tab=salaries');
    }
    const payload = buildSalaryPayload(req, normalizeString);
    await dbRun(
      `UPDATE hr_salaries
       SET employee_id = ?, effective_date = ?, salary_base = ?, bonus_amount = ?, extra_bonus = ?, fixed_deductions = ?,
           payment_method = ?, bank_account_number = ?, notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.effective_date,
        payload.salary_base,
        payload.bonus_amount,
        payload.extra_bonus,
        payload.fixed_deductions,
        payload.payment_method,
        payload.bank_account_number,
        payload.notes,
        payload.status,
        salaryId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Registro salarial actualizado.');
    return res.redirect('/rrhh?tab=salaries');
  }));

  app.post('/rrhh/salaries/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const salaryId = parsePositiveInt(req.params.id, null);
    await dbRun('DELETE FROM hr_salaries WHERE id = ? AND company_id = ?', [salaryId, companyId]);
    setFlash(req, 'success', 'Registro salarial eliminado.');
    return res.redirect('/rrhh?tab=salaries');
  }));

  app.post('/rrhh/overtime/create', requireAuth, requirePermission('rrhh', 'create'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildOvertimePayload(req, normalizeString);
    if (!(await ensureEmployee(companyId, payload.employee_id)) || !payload.overtime_date) {
      setFlash(req, 'error', 'Selecciona empleado y fecha de horas extras.');
      return res.redirect('/rrhh?tab=overtime');
    }
    await dbRun(
      `INSERT INTO hr_overtime (
         company_id, employee_id, overtime_date, start_time, end_time, total_hours, overtime_type,
         reason, approved_by, status, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.overtime_date,
        payload.start_time,
        payload.end_time,
        payload.total_hours,
        payload.overtime_type,
        payload.reason,
        payload.approved_by,
        payload.status,
        payload.notes
      ]
    );
    setFlash(req, 'success', 'Hora extra registrada.');
    return res.redirect('/rrhh?tab=overtime');
  }));

  app.post('/rrhh/overtime/:id/update', requireAuth, requirePermission('rrhh', 'edit'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const overtimeId = parsePositiveInt(req.params.id, null);
    const payload = buildOvertimePayload(req, normalizeString);
    await dbRun(
      `UPDATE hr_overtime
       SET employee_id = ?, overtime_date = ?, start_time = ?, end_time = ?, total_hours = ?, overtime_type = ?,
           reason = ?, approved_by = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.overtime_date,
        payload.start_time,
        payload.end_time,
        payload.total_hours,
        payload.overtime_type,
        payload.reason,
        payload.approved_by,
        payload.status,
        payload.notes,
        overtimeId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Hora extra actualizada.');
    return res.redirect('/rrhh?tab=overtime');
  }));

  app.post('/rrhh/overtime/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const overtimeId = parsePositiveInt(req.params.id, null);
    await dbRun('DELETE FROM hr_overtime WHERE id = ? AND company_id = ?', [overtimeId, companyId]);
    setFlash(req, 'success', 'Hora extra eliminada.');
    return res.redirect('/rrhh?tab=overtime');
  }));

  app.post('/rrhh/attendance/create', requireAuth, requirePermission('rrhh', 'create'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildAttendancePayload(req, normalizeString);
    if (!(await ensureEmployee(companyId, payload.employee_id)) || !payload.attendance_date) {
      setFlash(req, 'error', 'Selecciona empleado y fecha de asistencia.');
      return res.redirect('/rrhh?tab=attendance');
    }
    await dbRun(
      `INSERT INTO hr_attendance (
         company_id, employee_id, attendance_date, check_in, lunch_out, lunch_in, check_out,
         attendance_status, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.attendance_date,
        payload.check_in,
        payload.lunch_out,
        payload.lunch_in,
        payload.check_out,
        payload.attendance_status,
        payload.notes
      ]
    );
    setFlash(req, 'success', 'Asistencia registrada.');
    return res.redirect(`/rrhh?tab=attendance&month=${encodeURIComponent(payload.attendance_date.slice(0, 7))}`);
  }));

  app.post('/rrhh/attendance/:id/update', requireAuth, requirePermission('rrhh', 'edit'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const attendanceId = parsePositiveInt(req.params.id, null);
    const payload = buildAttendancePayload(req, normalizeString);
    await dbRun(
      `UPDATE hr_attendance
       SET employee_id = ?, attendance_date = ?, check_in = ?, lunch_out = ?, lunch_in = ?, check_out = ?,
           attendance_status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.attendance_date,
        payload.check_in,
        payload.lunch_out,
        payload.lunch_in,
        payload.check_out,
        payload.attendance_status,
        payload.notes,
        attendanceId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Asistencia actualizada.');
    return res.redirect(`/rrhh?tab=attendance&month=${encodeURIComponent(payload.attendance_date.slice(0, 7))}`);
  }));

  app.post('/rrhh/attendance/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const attendanceId = parsePositiveInt(req.params.id, null);
    await dbRun('DELETE FROM hr_attendance WHERE id = ? AND company_id = ?', [attendanceId, companyId]);
    setFlash(req, 'success', 'Asistencia eliminada.');
    return res.redirect('/rrhh?tab=attendance');
  }));

  app.post('/rrhh/warnings/create', requireAuth, requirePermission('rrhh', 'create'), singleAttachmentUpload, csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildWarningPayload(req, normalizeString);
    if (!(await ensureEmployee(companyId, payload.employee_id)) || !payload.warning_date || !payload.reason) {
      setFlash(req, 'error', 'Completa empleado, fecha y motivo de la llamada de atención.');
      return res.redirect('/rrhh?tab=warnings');
    }
    await dbRun(
      `INSERT INTO hr_warnings (
         company_id, employee_id, warning_date, warning_type, reason, detailed_description,
         corrective_action, issued_by, attachment_path, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.warning_date,
        payload.warning_type,
        payload.reason,
        payload.detailed_description,
        payload.corrective_action,
        payload.issued_by,
        req.file ? req.file.path : null,
        payload.status
      ]
    );
    setFlash(req, 'success', 'Llamada de atención registrada.');
    return res.redirect('/rrhh?tab=warnings');
  }));

  app.post('/rrhh/warnings/:id/update', requireAuth, requirePermission('rrhh', 'edit'), singleAttachmentUpload, csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const warningId = parsePositiveInt(req.params.id, null);
    const existing = await ensureRecordById('hr_warnings', companyId, warningId);
    if (!existing) {
      setFlash(req, 'error', 'Registro no encontrado.');
      return res.redirect('/rrhh?tab=warnings');
    }
    const payload = buildWarningPayload(req, normalizeString);
    await dbRun(
      `UPDATE hr_warnings
       SET employee_id = ?, warning_date = ?, warning_type = ?, reason = ?, detailed_description = ?,
           corrective_action = ?, issued_by = ?, attachment_path = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.warning_date,
        payload.warning_type,
        payload.reason,
        payload.detailed_description,
        payload.corrective_action,
        payload.issued_by,
        req.file ? req.file.path : existing.attachment_path,
        payload.status,
        warningId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Llamada de atención actualizada.');
    return res.redirect('/rrhh?tab=warnings');
  }));

  app.post('/rrhh/warnings/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const warningId = parsePositiveInt(req.params.id, null);
    await dbRun('DELETE FROM hr_warnings WHERE id = ? AND company_id = ?', [warningId, companyId]);
    setFlash(req, 'success', 'Llamada de atención eliminada.');
    return res.redirect('/rrhh?tab=warnings');
  }));

  app.post('/rrhh/descriptions/create', requireAuth, requirePermission('rrhh', 'create'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildDescriptionPayload(req, normalizeString);
    if (!payload.position_name || !payload.department) {
      setFlash(req, 'error', 'Completa puesto y departamento.');
      return res.redirect('/rrhh?tab=descriptions');
    }
    await dbRun(
      `INSERT INTO hr_job_descriptions (
         company_id, position_name, department, immediate_boss_title, job_objective, main_functions, secondary_functions,
         academic_requirements, required_experience, skills, competencies, work_schedule, suggested_salary,
         notes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.position_name,
        payload.department,
        payload.immediate_boss_title,
        payload.job_objective,
        payload.main_functions,
        payload.secondary_functions,
        payload.academic_requirements,
        payload.required_experience,
        payload.skills,
        payload.competencies,
        payload.work_schedule,
        payload.suggested_salary,
        payload.notes,
        payload.status
      ]
    );
    setFlash(req, 'success', 'Descripción de puesto creada.');
    return res.redirect('/rrhh?tab=descriptions');
  }));

  app.post('/rrhh/descriptions/:id/update', requireAuth, requirePermission('rrhh', 'edit'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const descriptionId = parsePositiveInt(req.params.id, null);
    const payload = buildDescriptionPayload(req, normalizeString);
    await dbRun(
      `UPDATE hr_job_descriptions
       SET position_name = ?, department = ?, immediate_boss_title = ?, job_objective = ?, main_functions = ?,
           secondary_functions = ?, academic_requirements = ?, required_experience = ?, skills = ?, competencies = ?,
           work_schedule = ?, suggested_salary = ?, notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.position_name,
        payload.department,
        payload.immediate_boss_title,
        payload.job_objective,
        payload.main_functions,
        payload.secondary_functions,
        payload.academic_requirements,
        payload.required_experience,
        payload.skills,
        payload.competencies,
        payload.work_schedule,
        payload.suggested_salary,
        payload.notes,
        payload.status,
        descriptionId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Descripción de puesto actualizada.');
    return res.redirect('/rrhh?tab=descriptions');
  }));

  app.post('/rrhh/descriptions/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const descriptionId = parsePositiveInt(req.params.id, null);
    await dbRun('UPDATE hr_employees SET job_description_id = NULL WHERE job_description_id = ? AND company_id = ?', [descriptionId, companyId]);
    await dbRun('DELETE FROM hr_job_descriptions WHERE id = ? AND company_id = ?', [descriptionId, companyId]);
    setFlash(req, 'success', 'Descripción de puesto eliminada.');
    return res.redirect('/rrhh?tab=descriptions');
  }));

  app.post('/rrhh/permissions/create', requireAuth, requirePermission('rrhh', 'create'), singleAttachmentUpload, csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = buildPermissionPayload(req, normalizeString);
    if (!(await ensureEmployee(companyId, payload.employee_id)) || !payload.permission_type || !payload.start_date || !payload.end_date) {
      setFlash(req, 'error', 'Completa empleado, tipo de permiso y rango de fechas.');
      return res.redirect('/rrhh?tab=permissions');
    }
    await dbRun(
      `INSERT INTO hr_permissions (
         company_id, employee_id, permission_type, start_date, end_date, total_days, with_pay, reason,
         approved_by, attachment_path, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.permission_type,
        payload.start_date,
        payload.end_date,
        payload.total_days,
        payload.with_pay,
        payload.reason,
        payload.approved_by,
        req.file ? req.file.path : null,
        payload.status
      ]
    );
    setFlash(req, 'success', 'Permiso registrado.');
    return res.redirect('/rrhh?tab=permissions');
  }));

  app.post('/rrhh/permissions/:id/update', requireAuth, requirePermission('rrhh', 'edit'), singleAttachmentUpload, csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const permissionId = parsePositiveInt(req.params.id, null);
    const existing = await ensureRecordById('hr_permissions', companyId, permissionId);
    if (!existing) {
      setFlash(req, 'error', 'Permiso no encontrado.');
      return res.redirect('/rrhh?tab=permissions');
    }
    const payload = buildPermissionPayload(req, normalizeString);
    await dbRun(
      `UPDATE hr_permissions
       SET employee_id = ?, permission_type = ?, start_date = ?, end_date = ?, total_days = ?, with_pay = ?,
           reason = ?, approved_by = ?, attachment_path = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.permission_type,
        payload.start_date,
        payload.end_date,
        payload.total_days,
        payload.with_pay,
        payload.reason,
        payload.approved_by,
        req.file ? req.file.path : existing.attachment_path,
        payload.status,
        permissionId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Permiso actualizado.');
    return res.redirect('/rrhh?tab=permissions');
  }));

  app.post('/rrhh/permissions/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const permissionId = parsePositiveInt(req.params.id, null);
    await dbRun('DELETE FROM hr_permissions WHERE id = ? AND company_id = ?', [permissionId, companyId]);
    setFlash(req, 'success', 'Permiso eliminado.');
    return res.redirect('/rrhh?tab=permissions');
  }));

  app.post('/rrhh/vacations/create', requireAuth, requirePermission('rrhh', 'create'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const payload = await buildVacationPayload(req, normalizeString, ensureEmployee, companyId);
    if (!payload.employee_id || !payload.vacation_start || !payload.vacation_end) {
      setFlash(req, 'error', 'Completa empleado y fechas de vacaciones.');
      return res.redirect('/rrhh?tab=vacations');
    }
    await dbRun(
      `INSERT INTO hr_vacations (
         company_id, employee_id, vacation_period, hire_date_snapshot, earned_days, used_days, available_days,
         vacation_start, vacation_end, return_date, status, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        companyId,
        payload.employee_id,
        payload.vacation_period,
        payload.hire_date_snapshot,
        payload.earned_days,
        payload.used_days,
        payload.available_days,
        payload.vacation_start,
        payload.vacation_end,
        payload.return_date,
        payload.status,
        payload.notes
      ]
    );
    setFlash(req, 'success', 'Solicitud de vacaciones registrada.');
    return res.redirect('/rrhh?tab=vacations');
  }));

  app.post('/rrhh/vacations/:id/update', requireAuth, requirePermission('rrhh', 'edit'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const vacationId = parsePositiveInt(req.params.id, null);
    const payload = await buildVacationPayload(req, normalizeString, ensureEmployee, companyId);
    await dbRun(
      `UPDATE hr_vacations
       SET employee_id = ?, vacation_period = ?, hire_date_snapshot = ?, earned_days = ?, used_days = ?, available_days = ?,
           vacation_start = ?, vacation_end = ?, return_date = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND company_id = ?`,
      [
        payload.employee_id,
        payload.vacation_period,
        payload.hire_date_snapshot,
        payload.earned_days,
        payload.used_days,
        payload.available_days,
        payload.vacation_start,
        payload.vacation_end,
        payload.return_date,
        payload.status,
        payload.notes,
        vacationId,
        companyId
      ]
    );
    setFlash(req, 'success', 'Vacaciones actualizadas.');
    return res.redirect('/rrhh?tab=vacations');
  }));

  app.post('/rrhh/vacations/:id/delete', requireAuth, requirePermission('rrhh', 'delete'), csrfMiddleware || passThrough, asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const vacationId = parsePositiveInt(req.params.id, null);
    await dbRun('DELETE FROM hr_vacations WHERE id = ? AND company_id = ?', [vacationId, companyId]);
    setFlash(req, 'success', 'Vacaciones eliminadas.');
    return res.redirect('/rrhh?tab=vacations');
  }));

  app.get('/rrhh/print/:tab/:id', requireAuth, requirePermission('rrhh', 'view'), asyncHandler(async (req, res) => {
    const companyId = getCompanyId(req);
    const tab = normalizeHrTab(req.params.tab);
    const id = parsePositiveInt(req.params.id, null);
    if (!PRINTABLE_TABS.has(tab) || !id) return res.redirect('/rrhh');

    let record = null;
    let title = '';
    if (tab === 'warnings') {
      record = await dbGet(
        `SELECT w.*, e.first_name || ' ' || e.last_name AS employee_name
         FROM hr_warnings w
         JOIN hr_employees e ON e.id = w.employee_id AND e.company_id = w.company_id
         WHERE w.id = ? AND w.company_id = ?`,
        [id, companyId]
      );
      title = 'Llamada de atención';
    }
    if (tab === 'descriptions') {
      record = await dbGet('SELECT * FROM hr_job_descriptions WHERE id = ? AND company_id = ?', [id, companyId]);
      title = 'Descripción de puesto';
    }
    if (tab === 'permissions') {
      record = await dbGet(
        `SELECT p.*, e.first_name || ' ' || e.last_name AS employee_name
         FROM hr_permissions p
         JOIN hr_employees e ON e.id = p.employee_id AND e.company_id = p.company_id
         WHERE p.id = ? AND p.company_id = ?`,
        [id, companyId]
      );
      title = 'Permiso';
    }
    if (!record) return res.redirect(`/rrhh?tab=${tab}`);
    return res.render('rrhh/record-print', { tab, title, record, buildFileUrl });
  }));
}

function initializeHrModule(db) {
  if (isHrInitialized) return;
  isHrInitialized = true;

  const ensureColumns = (table, columns) => {
    const safeTable = escapeSqlIdentifier(table);
    db.all(`PRAGMA table_info(${safeTable})`, (err, rows) => {
      if (err || !rows) return;
      const current = new Set(rows.map((row) => row.name));
      columns.forEach((column) => {
        if (current.has(column.name)) return;
        const safeColumn = escapeSqlIdentifier(column.name);
        db.run(`ALTER TABLE ${safeTable} ADD COLUMN ${safeColumn} ${column.type}`, (alterErr) => {
          if (alterErr && !isDuplicateColumnError(alterErr)) {
            console.warn('[rrhh/migration] no se pudo agregar una columna segura', {
              table,
              column: column.name,
              error: alterErr.message || String(alterErr)
            });
          }
        });
      });
    });
  };

  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS hr_job_descriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        position_name TEXT NOT NULL,
        department TEXT NOT NULL,
        immediate_boss_title TEXT,
        job_objective TEXT,
        main_functions TEXT,
        secondary_functions TEXT,
        academic_requirements TEXT,
        required_experience TEXT,
        skills TEXT,
        competencies TEXT,
        work_schedule TEXT,
        suggested_salary REAL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'Activa',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        dpi_number TEXT,
        dpi_issued_at TEXT,
        marital_status TEXT,
        married_last_name TEXT,
        gender TEXT,
        birth_date TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        education_level TEXT,
        ethnicity TEXT,
        languages TEXT,
        position TEXT,
        department TEXT,
        immediate_boss_id INTEGER,
        employee_code TEXT NOT NULL,
        hire_date TEXT,
        employment_status TEXT NOT NULL DEFAULT 'Activo',
        contract_type TEXT,
        salary_base REAL DEFAULT 0,
        bonus_amount REAL DEFAULT 0,
        payroll_calculation_type TEXT,
        bank_account_number TEXT,
        bank_account_type TEXT,
        bank_name TEXT,
        photo_path TEXT,
        job_application_path TEXT,
        notes TEXT,
        job_description_id INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_employee_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        attachment_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_name TEXT,
        mime_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        contract_type TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT,
        work_schedule TEXT,
        workday_type TEXT,
        salary REAL DEFAULT 0,
        bonus_amount REAL DEFAULT 0,
        workplace TEXT,
        probation_period TEXT,
        main_functions TEXT,
        extra_clauses TEXT,
        observations TEXT,
        generated_contract_text TEXT,
        status TEXT NOT NULL DEFAULT 'Borrador',
        pdf_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_salaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        effective_date TEXT NOT NULL,
        salary_base REAL DEFAULT 0,
        bonus_amount REAL DEFAULT 0,
        extra_bonus REAL DEFAULT 0,
        fixed_deductions REAL DEFAULT 0,
        payment_method TEXT,
        bank_account_number TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'Vigente',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_overtime (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        overtime_date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        total_hours REAL DEFAULT 0,
        overtime_type TEXT,
        reason TEXT,
        approved_by TEXT,
        status TEXT NOT NULL DEFAULT 'Pendiente',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        attendance_date TEXT NOT NULL,
        check_in TEXT,
        lunch_out TEXT,
        lunch_in TEXT,
        check_out TEXT,
        attendance_status TEXT NOT NULL DEFAULT 'Presente',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        warning_date TEXT NOT NULL,
        warning_type TEXT,
        reason TEXT NOT NULL,
        detailed_description TEXT,
        corrective_action TEXT,
        issued_by TEXT,
        attachment_path TEXT,
        status TEXT NOT NULL DEFAULT 'Emitida',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        permission_type TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        total_days REAL DEFAULT 0,
        with_pay INTEGER NOT NULL DEFAULT 1,
        reason TEXT,
        approved_by TEXT,
        attachment_path TEXT,
        status TEXT NOT NULL DEFAULT 'Pendiente',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS hr_vacations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        vacation_period TEXT,
        hire_date_snapshot TEXT,
        earned_days REAL DEFAULT 0,
        used_days REAL DEFAULT 0,
        available_days REAL DEFAULT 0,
        vacation_start TEXT NOT NULL,
        vacation_end TEXT NOT NULL,
        return_date TEXT,
        status TEXT NOT NULL DEFAULT 'Pendiente',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );

    ensureColumns('hr_employees', [
      { name: 'company_id', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'job_description_id', type: 'INTEGER' },
      { name: 'is_active', type: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'photo_path', type: 'TEXT' },
      { name: 'job_application_path', type: 'TEXT' }
    ]);
    ensureColumns('hr_contracts', [{ name: 'pdf_path', type: 'TEXT' }]);
    ensureColumns('hr_permissions', [{ name: 'attachment_path', type: 'TEXT' }]);
    ensureColumns('hr_warnings', [{ name: 'attachment_path', type: 'TEXT' }]);
    ensureColumns('hr_vacations', [{ name: 'available_days', type: 'REAL DEFAULT 0' }]);

    db.run('CREATE INDEX IF NOT EXISTS idx_hr_employees_company ON hr_employees (company_id)');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_employees_company_code ON hr_employees (company_id, employee_code)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_employees_company_dept ON hr_employees (company_id, department)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_employee_attachments_company ON hr_employee_attachments (company_id, employee_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_contracts_company_employee ON hr_contracts (company_id, employee_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_salaries_company_employee ON hr_salaries (company_id, employee_id, effective_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_overtime_company_employee ON hr_overtime (company_id, employee_id, overtime_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_attendance_company_employee ON hr_attendance (company_id, employee_id, attendance_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_warnings_company_employee ON hr_warnings (company_id, employee_id, warning_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_permissions_company_employee ON hr_permissions (company_id, employee_id, start_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_vacations_company_employee ON hr_vacations (company_id, employee_id, vacation_start)');
    db.run('CREATE INDEX IF NOT EXISTS idx_hr_descriptions_company_dept ON hr_job_descriptions (company_id, department)');

    db.run(`INSERT OR IGNORE INTO permission_modules (code, name, description) VALUES ('rrhh', 'RRHH', 'Gestión integral de recursos humanos')`);
    db.run(
      `INSERT OR IGNORE INTO module_actions (module_id, action_id)
       SELECT pm.id, pa.id
       FROM permission_modules pm, permission_actions pa
       WHERE pm.code = 'rrhh' AND pa.code IN ('view', 'create', 'edit', 'delete', 'export', 'approve')`
    );
  });
}

function ensureDir(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function safeExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return ext || '.bin';
}

function isAllowedDocument(file) {
  const allowedMime = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ]);
  const allowedExt = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.png', '.jpg', '.jpeg', '.webp']);
  const ext = safeExtension(file && file.originalname);
  if (file && file.mimetype && file.mimetype.startsWith('image/')) return true;
  return allowedMime.has(file && file.mimetype) || allowedExt.has(ext);
}

function detectAttachmentSection(url) {
  const raw = String(url || '');
  if (raw.includes('/permissions/')) return 'permissions';
  return 'warnings';
}

function normalizeHrTab(value) {
  const tab = String(value || '').trim().toLowerCase();
  return HR_TAB_SET.has(tab) ? tab : 'employees';
}

function normalizeEmployeeView(value) {
  return String(value || '').trim().toLowerCase() === 'cards' ? 'cards' : 'list';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildPagination(page, total, pageSize) {
  const safePageSize = pageSize || DEFAULT_PAGE_SIZE;
  const totalItems = Number(total) || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(Math.max(page || 1, 1), totalPages);
  return {
    page: currentPage,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    offset: (currentPage - 1) * safePageSize
  };
}

function normalizeMonth(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(raw) ? raw : '';
}

function formatMonth(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMoney(value) {
  return Number(toNumber(value)).toFixed(2);
}

function parseCheckbox(value) {
  return value === '1' || value === 'on' || value === true ? 1 : 0;
}

function parseTimeToMinutes(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function calculateHoursBetween(start, end) {
  const startMinutes = parseTimeToMinutes(start);
  const endMinutes = parseTimeToMinutes(end);
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return 0;
  return (endMinutes - startMinutes) / 60;
}

function calculateWorkedHours(checkIn, lunchOut, lunchIn, checkOut) {
  const totalDay = calculateHoursBetween(checkIn, checkOut);
  const lunchBreak = calculateHoursBetween(lunchOut, lunchIn);
  const safe = totalDay - lunchBreak;
  return safe > 0 ? safe : 0;
}

function isLateCheckIn(value) {
  const current = parseTimeToMinutes(value);
  const limit = parseTimeToMinutes(LATE_THRESHOLD);
  if (current === null || limit === null) return false;
  return current > limit;
}

function daysInclusive(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / 86400000) + 1;
}

function addDays(dateValue, days) {
  const base = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(base.getTime())) return '';
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function estimateEarnedVacationDays(hireDateSnapshot, referenceDate) {
  if (!hireDateSnapshot || !referenceDate) return 0;
  const start = new Date(`${hireDateSnapshot}T00:00:00`);
  const end = new Date(`${referenceDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000);
  return Number(((days / 365) * VACATION_DAYS_PER_YEAR).toFixed(2));
}

function buildAttendanceCalendar(month, rows) {
  const safeMonth = normalizeMonth(month) || formatMonth(new Date());
  const [year, monthNumber] = safeMonth.split('-').map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1);
  const firstWeekDay = firstDay.getDay();
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const map = new Map(
    (rows || []).map((row) => [
      row.attendance_date,
      {
        status: row.attendance_status,
        workedHours: calculateWorkedHours(row.check_in, row.lunch_out, row.lunch_in, row.check_out).toFixed(2),
        late: isLateCheckIn(row.check_in)
      }
    ])
  );
  const weeks = [];
  let currentDay = 1 - firstWeekDay;
  while (currentDay <= lastDay) {
    const week = [];
    for (let idx = 0; idx < 7; idx += 1) {
      if (currentDay < 1 || currentDay > lastDay) {
        week.push(null);
      } else {
        const date = `${safeMonth}-${String(currentDay).padStart(2, '0')}`;
        week.push({
          day: currentDay,
          date,
          record: map.get(date) || null
        });
      }
      currentDay += 1;
    }
    weeks.push(week);
  }
  return {
    month: safeMonth,
    label: firstDay.toLocaleDateString('es-GT', { month: 'long', year: 'numeric' }),
    weeks
  };
}

function buildOrgNodes(byBoss, bossId, depth) {
  const children = (byBoss.get(bossId) || []).map((node) => ({
    ...node,
    depth,
    children: buildOrgNodes(byBoss, node.id, depth + 1)
  }));
  return children;
}

function buildEmployeePayload(req, normalizeString) {
  return {
    first_name: normalizeString(req.body.first_name),
    last_name: normalizeString(req.body.last_name),
    dpi_number: normalizeString(req.body.dpi_number),
    dpi_issued_at: normalizeString(req.body.dpi_issued_at),
    marital_status: normalizeString(req.body.marital_status),
    married_last_name: normalizeString(req.body.married_last_name),
    gender: normalizeString(req.body.gender),
    birth_date: normalizeString(req.body.birth_date),
    phone: normalizeString(req.body.phone),
    email: normalizeString(req.body.email),
    address: normalizeString(req.body.address),
    education_level: normalizeString(req.body.education_level),
    ethnicity: normalizeString(req.body.ethnicity),
    languages: normalizeString(req.body.languages),
    position: normalizeString(req.body.position),
    department: normalizeString(req.body.department),
    immediate_boss_id: parsePositiveInt(req.body.immediate_boss_id, null),
    employee_code: normalizeString(req.body.employee_code),
    hire_date: normalizeString(req.body.hire_date),
    employment_status: normalizeString(req.body.employment_status) || 'Activo',
    contract_type: normalizeString(req.body.contract_type),
    salary_base: toNumber(req.body.salary_base, 0),
    bonus_amount: toNumber(req.body.bonus_amount, 0),
    payroll_calculation_type: normalizeString(req.body.payroll_calculation_type),
    bank_account_number: normalizeString(req.body.bank_account_number),
    bank_account_type: normalizeString(req.body.bank_account_type),
    bank_name: normalizeString(req.body.bank_name),
    notes: normalizeString(req.body.notes),
    job_description_id: parsePositiveInt(req.body.job_description_id, null),
    is_active: parseCheckbox(req.body.is_active)
  };
}

function buildContractPayload(req, normalizeString) {
  return {
    employee_id: parsePositiveInt(req.body.employee_id, null),
    contract_type: normalizeString(req.body.contract_type),
    start_date: normalizeString(req.body.start_date),
    end_date: normalizeString(req.body.end_date),
    work_schedule: normalizeString(req.body.work_schedule),
    workday_type: normalizeString(req.body.workday_type),
    salary: toNumber(req.body.salary, 0),
    bonus_amount: toNumber(req.body.bonus_amount, 0),
    workplace: normalizeString(req.body.workplace),
    probation_period: normalizeString(req.body.probation_period),
    main_functions: normalizeString(req.body.main_functions),
    extra_clauses: normalizeString(req.body.extra_clauses),
    observations: normalizeString(req.body.observations),
    status: normalizeString(req.body.status) || 'Borrador'
  };
}

function buildSalaryPayload(req, normalizeString) {
  return {
    employee_id: parsePositiveInt(req.body.employee_id, null),
    effective_date: normalizeString(req.body.effective_date),
    salary_base: toNumber(req.body.salary_base, 0),
    bonus_amount: toNumber(req.body.bonus_amount, 0),
    extra_bonus: toNumber(req.body.extra_bonus, 0),
    fixed_deductions: toNumber(req.body.fixed_deductions, 0),
    payment_method: normalizeString(req.body.payment_method),
    bank_account_number: normalizeString(req.body.bank_account_number),
    notes: normalizeString(req.body.notes),
    status: normalizeString(req.body.status) || 'Vigente'
  };
}

function buildOvertimePayload(req, normalizeString) {
  const startTime = normalizeString(req.body.start_time);
  const endTime = normalizeString(req.body.end_time);
  return {
    employee_id: parsePositiveInt(req.body.employee_id, null),
    overtime_date: normalizeString(req.body.overtime_date),
    start_time: startTime,
    end_time: endTime,
    total_hours: Number(calculateHoursBetween(startTime, endTime).toFixed(2)),
    overtime_type: normalizeString(req.body.overtime_type),
    reason: normalizeString(req.body.reason),
    approved_by: normalizeString(req.body.approved_by),
    status: normalizeString(req.body.status) || 'Pendiente',
    notes: normalizeString(req.body.notes)
  };
}

function buildAttendancePayload(req, normalizeString) {
  const checkIn = normalizeString(req.body.check_in);
  return {
    employee_id: parsePositiveInt(req.body.employee_id, null),
    attendance_date: normalizeString(req.body.attendance_date),
    check_in: checkIn,
    lunch_out: normalizeString(req.body.lunch_out),
    lunch_in: normalizeString(req.body.lunch_in),
    check_out: normalizeString(req.body.check_out),
    attendance_status: normalizeString(req.body.attendance_status) || (isLateCheckIn(checkIn) ? 'Tarde' : 'Presente'),
    notes: normalizeString(req.body.notes)
  };
}

function buildWarningPayload(req, normalizeString) {
  return {
    employee_id: parsePositiveInt(req.body.employee_id, null),
    warning_date: normalizeString(req.body.warning_date),
    warning_type: normalizeString(req.body.warning_type),
    reason: normalizeString(req.body.reason),
    detailed_description: normalizeString(req.body.detailed_description),
    corrective_action: normalizeString(req.body.corrective_action),
    issued_by: normalizeString(req.body.issued_by),
    status: normalizeString(req.body.status) || 'Emitida'
  };
}

function buildDescriptionPayload(req, normalizeString) {
  return {
    position_name: normalizeString(req.body.position_name),
    department: normalizeString(req.body.department),
    immediate_boss_title: normalizeString(req.body.immediate_boss_title),
    job_objective: normalizeString(req.body.job_objective),
    main_functions: normalizeString(req.body.main_functions),
    secondary_functions: normalizeString(req.body.secondary_functions),
    academic_requirements: normalizeString(req.body.academic_requirements),
    required_experience: normalizeString(req.body.required_experience),
    skills: normalizeString(req.body.skills),
    competencies: normalizeString(req.body.competencies),
    work_schedule: normalizeString(req.body.work_schedule),
    suggested_salary: toNumber(req.body.suggested_salary, 0),
    notes: normalizeString(req.body.notes),
    status: normalizeString(req.body.status) || 'Activa'
  };
}

function buildPermissionPayload(req, normalizeString) {
  const startDate = normalizeString(req.body.start_date);
  const endDate = normalizeString(req.body.end_date);
  return {
    employee_id: parsePositiveInt(req.body.employee_id, null),
    permission_type: normalizeString(req.body.permission_type),
    start_date: startDate,
    end_date: endDate,
    total_days: Number(daysInclusive(startDate, endDate).toFixed(2)),
    with_pay: parseCheckbox(req.body.with_pay),
    reason: normalizeString(req.body.reason),
    approved_by: normalizeString(req.body.approved_by),
    status: normalizeString(req.body.status) || 'Pendiente'
  };
}

async function buildVacationPayload(req, normalizeString, ensureEmployee, companyId) {
  const employeeId = parsePositiveInt(req.body.employee_id, null);
  const employee = employeeId ? await ensureEmployee(companyId, employeeId) : null;
  const vacationStart = normalizeString(req.body.vacation_start);
  const vacationEnd = normalizeString(req.body.vacation_end);
  const hireDateSnapshot = normalizeString(req.body.hire_date_snapshot) || (employee ? employee.hire_date : '');
  const earnedRaw = String(req.body.earned_days || '').trim();
  const usedRaw = String(req.body.used_days || '').trim();
  const earnedDaysInput = earnedRaw === '' ? Number.NaN : Number(earnedRaw);
  const usedDaysInput = usedRaw === '' ? Number.NaN : Number(usedRaw);
  const vacationDays = daysInclusive(vacationStart, vacationEnd);
  const earnedDays = Number.isFinite(earnedDaysInput)
    ? earnedDaysInput
    : estimateEarnedVacationDays(hireDateSnapshot, vacationEnd || vacationStart);
  const usedDays = Number.isFinite(usedDaysInput) ? usedDaysInput : vacationDays;
  const availableDays = Number((earnedDays - usedDays).toFixed(2));
  return {
    employee_id: employee ? employee.id : null,
    vacation_period: normalizeString(req.body.vacation_period) || `${(vacationStart || '').slice(0, 4) || new Date().getFullYear()}`,
    hire_date_snapshot: hireDateSnapshot,
    earned_days: Number(earnedDays.toFixed(2)),
    used_days: Number(usedDays.toFixed(2)),
    available_days: availableDays,
    vacation_start: vacationStart,
    vacation_end: vacationEnd,
    return_date: normalizeString(req.body.return_date) || addDays(vacationEnd, 1),
    status: normalizeString(req.body.status) || 'Pendiente',
    notes: normalizeString(req.body.notes)
  };
}

function pickSingleFile(files, fieldName) {
  return files && Array.isArray(files[fieldName]) && files[fieldName][0] ? files[fieldName][0] : null;
}

async function insertEmployeeAttachments(dbRun, employeeId, companyId, files) {
  const inserts = [];
  const singleTypes = [
    { field: 'dpi_front', type: 'dpi_front' },
    { field: 'dpi_back', type: 'dpi_back' },
    { field: 'signed_contract', type: 'signed_contract' }
  ];
  singleTypes.forEach((entry) => {
    const file = pickSingleFile(files, entry.field);
    if (!file) return;
    inserts.push(
      dbRun(
        `INSERT INTO hr_employee_attachments (company_id, employee_id, attachment_type, file_path, original_name, mime_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [companyId, employeeId, entry.type, file.path, file.originalname || null, file.mimetype || null]
      )
    );
  });
  const others = files && Array.isArray(files.other_documents) ? files.other_documents : [];
  others.forEach((file) => {
    inserts.push(
      dbRun(
        `INSERT INTO hr_employee_attachments (company_id, employee_id, attachment_type, file_path, original_name, mime_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [companyId, employeeId, 'other_document', file.path, file.originalname || null, file.mimetype || null]
      )
    );
  });
  await Promise.all(inserts);
}

function buildContractText(employee, contract) {
  const employeeName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
  const lines = [
    'CONTRATO INDIVIDUAL DE TRABAJO',
    '',
    'Entre las partes comparecen, por una parte, LA EMPRESA, y por la otra, EL TRABAJADOR, quienes convienen celebrar el presente contrato individual de trabajo sujeto a las cláusulas siguientes:',
    '',
    `PRIMERA. IDENTIFICACIÓN DEL TRABAJADOR: ${employeeName}, identificado con DPI ${employee.dpi_number || 'N/D'}, con domicilio en ${employee.address || 'N/D'}.`,
    `SEGUNDA. PUESTO Y ADSCRIPCIÓN: El trabajador prestará sus servicios como ${employee.position || contract.contract_type || 'Colaborador'} en el departamento de ${employee.department || 'General'}.`,
    `TERCERA. FECHA DE INICIO: Las labores iniciarán el ${contract.start_date || 'N/D'}${contract.end_date ? ` y concluirán el ${contract.end_date}` : ', con duración indefinida hasta nueva disposición contractual'}.`,
    `CUARTA. JORNADA: La jornada se desarrollará bajo el horario ${contract.work_schedule || 'según necesidades de la empresa'} y modalidad ${contract.workday_type || 'ordinaria'}.`,
    `QUINTA. REMUNERACIÓN: La empresa pagará un salario base de Q${toMoney(contract.salary)} y bono de Q${toMoney(contract.bonus_amount)}.`,
    `SEXTA. CENTRO DE TRABAJO: El trabajador prestará sus servicios en ${contract.workplace || 'las instalaciones que la empresa designe'}.`,
    `SÉPTIMA. PERÍODO DE PRUEBA: ${contract.probation_period || 'No aplica'} .`,
    `OCTAVA. FUNCIONES PRINCIPALES: ${contract.main_functions || 'Las propias del puesto y las que sean afines a la naturaleza del cargo.'}`,
    `NOVENA. JEFE INMEDIATO: ${employee.immediate_boss_name || 'Según organigrama vigente de la empresa'}.`,
    `DÉCIMA. CLÁUSULAS ADICIONALES: ${contract.extra_clauses || 'Las partes se obligan a cumplir con el reglamento interno, políticas de la empresa y demás normativa aplicable.'}`,
    `DÉCIMA PRIMERA. OBSERVACIONES: ${contract.observations || 'Sin observaciones adicionales.'}`,
    '',
    'Leído que fue el presente contrato y enteradas las partes de su contenido y alcance legal, lo firman en señal de aceptación.',
    '',
    '______________________________',
    'Representante de la empresa',
    '',
    '______________________________',
    employeeName
  ];
  return lines.join('\n');
}

async function loadContractDetail(dbGet, companyId, contractId) {
  const contract = await dbGet(
    `SELECT c.*,
            e.first_name || ' ' || e.last_name AS employee_name,
            e.dpi_number,
            e.address,
            e.position,
            e.department,
            e.hire_date,
            boss.first_name || ' ' || boss.last_name AS immediate_boss_name
     FROM hr_contracts c
     JOIN hr_employees e ON e.id = c.employee_id AND e.company_id = c.company_id
     LEFT JOIN hr_employees boss ON boss.id = e.immediate_boss_id AND boss.company_id = e.company_id
     WHERE c.id = ? AND c.company_id = ?`,
    [contractId, companyId]
  );
  if (!contract) return null;
  return contract;
}

function writeContractPdf(filePath, contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);
    doc.fontSize(18).text('Contrato Laboral', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10);
    doc.text(`Empleado: ${contract.employee_name || '-'}`);
    doc.text(`Puesto: ${contract.position || '-'}`);
    doc.text(`Departamento: ${contract.department || '-'}`);
    doc.text(`Inicio: ${contract.start_date || '-'}`);
    doc.text(`Fin: ${contract.end_date || 'Indefinido'}`);
    doc.text(`Salario: Q${toMoney(contract.salary)}`);
    doc.moveDown();
    doc.fontSize(11).text(contract.generated_contract_text || '', {
      align: 'justify',
      lineGap: 3
    });
    doc.end();
  });
}

function passThrough(req, res, next) {
  next();
}

module.exports = {
  registerHrRoutes
};
