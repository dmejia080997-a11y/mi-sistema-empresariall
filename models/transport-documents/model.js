const VALID_TYPES = ['MAWB', 'CARTA_PORTE', 'BL'];
const VALID_STATUSES = ['draft', 'issued', 'voided'];

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeType(value) {
  const type = normalizeText(value).toUpperCase();
  return VALID_TYPES.includes(type) ? type : 'MAWB';
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  return VALID_STATUSES.includes(status) ? status : 'draft';
}

function serializeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch (err) {
    return '{}';
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function ensureTransportDocumentTables(db) {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS transport_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        document_number TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        issue_date TEXT NULL,
        client_name TEXT NULL,
        shipper TEXT NULL,
        consignee TEXT NULL,
        origin TEXT NULL,
        destination TEXT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_by INTEGER NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS transport_document_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        document_id INTEGER NOT NULL,
        line_no INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES transport_documents(id)
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS transport_document_charges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        document_id INTEGER NOT NULL,
        line_no INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES transport_documents(id)
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS transport_document_merchandise (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        document_id INTEGER NOT NULL,
        line_no INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES transport_documents(id)
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_documents_company_type ON transport_documents (company_id, type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_documents_company_status ON transport_documents (company_id, status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_documents_company_date ON transport_documents (company_id, issue_date)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_items_doc ON transport_document_items (company_id, document_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_charges_doc ON transport_document_charges (company_id, document_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_transport_merchandise_doc ON transport_document_merchandise (company_id, document_id)');
  });
}

function mapDocument(row) {
  if (!row) return null;
  return {
    ...row,
    data: parseJson(row.data, {})
  };
}

function listDocuments(db, companyId, filters, callback) {
  const clauses = ['company_id = ?'];
  const params = [companyId];
  if (filters.type && filters.type !== 'all') {
    clauses.push('type = ?');
    params.push(normalizeType(filters.type));
  }
  if (filters.status && filters.status !== 'all') {
    clauses.push('status = ?');
    params.push(normalizeStatus(filters.status));
  }
  if (filters.client) {
    clauses.push('client_name LIKE ?');
    params.push(`%${filters.client}%`);
  }
  if (filters.issue_date) {
    clauses.push('issue_date = ?');
    params.push(filters.issue_date);
  }
  db.all(
    `SELECT *
     FROM transport_documents
     WHERE ${clauses.join(' AND ')}
     ORDER BY COALESCE(issue_date, created_at) DESC, id DESC`,
    params,
    (err, rows) => callback(err, (rows || []).map(mapDocument))
  );
}

function getDocument(db, companyId, id, callback) {
  db.get('SELECT * FROM transport_documents WHERE id = ? AND company_id = ?', [id, companyId], (err, row) => {
    if (err || !row) return callback(err, mapDocument(row));
    const document = mapDocument(row);
    db.all(
      `SELECT 'items' AS group_name, line_no, data FROM transport_document_items WHERE document_id = ? AND company_id = ?
       UNION ALL
       SELECT 'charges' AS group_name, line_no, data FROM transport_document_charges WHERE document_id = ? AND company_id = ?
       UNION ALL
       SELECT 'merchandise' AS group_name, line_no, data FROM transport_document_merchandise WHERE document_id = ? AND company_id = ?
       ORDER BY group_name, line_no`,
      [id, companyId, id, companyId, id, companyId],
      (childErr, rows) => {
        if (childErr) return callback(childErr);
        document.items = [];
        document.charges = [];
        document.merchandise = [];
        (rows || []).forEach((child) => {
          const group = child.group_name;
          if (document[group]) document[group].push(parseJson(child.data, {}));
        });
        callback(null, document);
      }
    );
  });
}

function insertChildren(db, table, companyId, documentId, rows, callback) {
  const cleanRows = (rows || []).filter((row) =>
    Object.values(row || {}).some((value) => normalizeText(value))
  );
  if (!cleanRows.length) return callback();
  const stmt = db.prepare(`INSERT INTO ${table} (company_id, document_id, line_no, data) VALUES (?, ?, ?, ?)`);
  let pending = cleanRows.length;
  let firstErr = null;
  cleanRows.forEach((row, index) => {
    stmt.run(companyId, documentId, index + 1, serializeJson(row), (err) => {
      if (err && !firstErr) firstErr = err;
      pending -= 1;
      if (pending === 0) stmt.finalize(() => callback(firstErr));
    });
  });
}

function replaceChildren(db, companyId, documentId, payload, callback) {
  db.serialize(() => {
    db.run('DELETE FROM transport_document_items WHERE company_id = ? AND document_id = ?', [companyId, documentId]);
    db.run('DELETE FROM transport_document_charges WHERE company_id = ? AND document_id = ?', [companyId, documentId]);
    db.run('DELETE FROM transport_document_merchandise WHERE company_id = ? AND document_id = ?', [companyId, documentId]);
    insertChildren(db, 'transport_document_items', companyId, documentId, payload.items, (itemErr) => {
      if (itemErr) return callback(itemErr);
      insertChildren(db, 'transport_document_charges', companyId, documentId, payload.charges, (chargeErr) => {
        if (chargeErr) return callback(chargeErr);
        insertChildren(db, 'transport_document_merchandise', companyId, documentId, payload.merchandise, callback);
      });
    });
  });
}

function createDocument(db, companyId, userId, payload, callback) {
  const type = normalizeType(payload.type);
  db.run(
    `INSERT INTO transport_documents
     (company_id, type, document_number, status, issue_date, client_name, shipper, consignee, origin, destination, data, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      companyId,
      type,
      normalizeText(payload.document_number),
      normalizeStatus(payload.status),
      normalizeText(payload.issue_date) || null,
      normalizeText(payload.client_name) || null,
      normalizeText(payload.shipper) || null,
      normalizeText(payload.consignee) || null,
      normalizeText(payload.origin) || null,
      normalizeText(payload.destination) || null,
      serializeJson(payload.data),
      userId || null
    ],
    function onInsert(err) {
      if (err) return callback(err);
      const documentId = this.lastID;
      replaceChildren(db, companyId, documentId, payload, (childErr) => callback(childErr, documentId));
    }
  );
}

function updateDocument(db, companyId, id, payload, callback) {
  db.run(
    `UPDATE transport_documents
     SET type = ?, document_number = ?, status = ?, issue_date = ?, client_name = ?, shipper = ?,
         consignee = ?, origin = ?, destination = ?, data = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ? AND status != 'voided'`,
    [
      normalizeType(payload.type),
      normalizeText(payload.document_number),
      normalizeStatus(payload.status),
      normalizeText(payload.issue_date) || null,
      normalizeText(payload.client_name) || null,
      normalizeText(payload.shipper) || null,
      normalizeText(payload.consignee) || null,
      normalizeText(payload.origin) || null,
      normalizeText(payload.destination) || null,
      serializeJson(payload.data),
      id,
      companyId
    ],
    function onUpdate(err) {
      if (err || this.changes < 1) return callback(err || new Error('Documento no editable'));
      replaceChildren(db, companyId, id, payload, callback);
    }
  );
}

function voidDocument(db, companyId, id, callback) {
  db.run(
    "UPDATE transport_documents SET status = 'voided', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?",
    [id, companyId],
    callback
  );
}

module.exports = {
  VALID_TYPES,
  VALID_STATUSES,
  ensureTransportDocumentTables,
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  voidDocument
};
