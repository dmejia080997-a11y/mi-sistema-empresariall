function registerPackageRoutes(app, deps) {
  const {
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
  } = deps;
app.get('/packages/home', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  return res.render('packages-home', { packagesNav: 'list' });
});

app.get('/packages/dashboard', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  computePackageStats(companyId, (stats) => {
    res.render('packages-dashboard', { stats, packagesNav: 'dashboard' });
  });
});

app.get('/packages', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    q: normalizeString(req.query.q),
    status: normalizeString(req.query.status),
    customer: normalizeString(req.query.customer),
    carrier: normalizeString(req.query.carrier),
    received_date: normalizeString(req.query.received_date)
  };

  computePackageStats(companyId, (stats) => {
    computePackageStatusCounts(companyId, (statusCounts) => {
      db.all('SELECT id, name, customer_code FROM customers WHERE company_id = ? AND is_voided = 0 ORDER BY name', [companyId], (custErr, customers) => {
        fetchPackagesList(companyId, filters, (listErr, packages) => {
          const params = new URLSearchParams();
          Object.keys(filters).forEach((key) => {
            if (filters[key]) params.set(key, filters[key]);
          });
          const exportUrl = params.toString() ? `/packages/export?${params.toString()}` : '/packages/export';

          res.render('packages', {
            packages: listErr ? [] : packages,
            customers: custErr ? [] : customers || [],
            filters,
            statuses: PACKAGE_STATUSES,
            statusCounts,
            stats,
            exportUrl,
            urgentConfig: {
              stuckDays: URGENT_STUCK_DAYS,
              invoiceDays: URGENT_INVOICE_DAYS,
              customsDays: URGENT_CUSTOMS_DAYS
            },
            error: null,
            packagesNav: 'list'
          });
        });
      });
    });
  });
});

app.get('/packages/pending-invoice', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  fetchPendingInvoicePackages(companyId, (err, packages) => {
    res.render('packages-pending-invoice', {
      packages: err ? [] : packages,
      packagesNav: 'pending_invoice',
      error: err ? res.locals.t('errors.server_try_again') : null,
      flash: res.locals.flash
    });
  });
});

app.get('/packages/statuses', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  res.render('packages-statuses', { statuses: PACKAGE_STATUSES, packagesNav: 'statuses' });
});

app.get('/packages/status-by-manifest', requireAuth, requirePermission('packages', 'change_status'), (req, res) => {
  const companyId = getCompanyId(req);
  const status = normalizeString(req.query.status);
  if (!PACKAGE_STATUSES.includes(status)) {
    setFlash(req, 'error', res.locals.t('packages.status_manifest.flash_invalid'));
    return res.redirect('/dashboard');
  }

  db.all(
    `SELECT m.*,
            (SELECT COUNT(*) FROM manifest_pieces mp WHERE mp.manifest_id = m.id) AS piece_count,
            (SELECT COUNT(*)
             FROM manifest_piece_packages mpp
             JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
             WHERE mp.manifest_id = m.id) AS package_count
     FROM manifests m
     WHERE m.company_id = ? AND m.status = 'closed'
     ORDER BY m.created_at DESC`,
    [companyId],
    (err, manifests) => {
      res.render('packages-status-manifest', {
        status,
        manifests: err ? [] : manifests || [],
        flash: res.locals.flash,
        packagesNav: 'statuses'
      });
    }
  );
});

app.post('/packages/status-by-manifest/manifest', requireAuth, requirePermission('packages', 'change_status'), (req, res) => {
  const companyId = getCompanyId(req);
  const status = normalizeString(req.body.status);
  const manifestId = Number(req.body.manifest_id || 0);
  const redirectUrl = `/packages/status-by-manifest?status=${encodeURIComponent(status || '')}`;
  if (!companyId || !PACKAGE_STATUSES.includes(status) || !Number.isInteger(manifestId) || manifestId <= 0) {
    setFlash(req, 'error', res.locals.t('packages.status_manifest.flash_invalid'));
    return res.redirect(redirectUrl);
  }

  db.get(
    'SELECT id FROM manifests WHERE id = ? AND company_id = ?',
    [manifestId, companyId],
    (manifestErr, manifest) => {
      if (manifestErr || !manifest) {
        setFlash(req, 'error', res.locals.t('packages.status_manifest.flash_invalid'));
        return res.redirect(redirectUrl);
      }
      findPackagesTable((table) => {
        if (!table) {
          setFlash(req, 'error', res.locals.t('errors.server_try_again'));
          return res.redirect(redirectUrl);
        }
        db.all(
          `SELECT DISTINCT p.id
           FROM manifest_piece_packages mpp
           JOIN manifest_pieces mp ON mp.id = mpp.manifest_piece_id
           JOIN ${table} p ON p.id = mpp.package_id
           WHERE mp.manifest_id = ? AND p.company_id = ?`,
          [manifestId, companyId],
          (pkgErr, rows) => {
            if (pkgErr || !rows || rows.length === 0) {
              setFlash(req, 'error', res.locals.t('packages.status_manifest.flash_manifest_empty'));
              return res.redirect(redirectUrl);
            }
            let remaining = rows.length;
            let updated = 0;
            const changedBy = req.session && req.session.user ? req.session.user.id : null;
            rows.forEach((row) => {
              updatePackageStatusWithHistory(
                companyId,
                row.id,
                status,
                changedBy,
                `Actualizado por manifiesto #${manifestId}`,
                (updateErr, didUpdate) => {
                  if (!updateErr && didUpdate) updated += 1;
                  remaining -= 1;
                  if (remaining <= 0) {
                    setFlash(
                      req,
                      'success',
                      res.locals.t('packages.status_manifest.flash_manifest_updated', {
                        status,
                        updated,
                        total: rows.length,
                        manifestId
                      })
                    );
                    return res.redirect(redirectUrl);
                  }
                }
              );
            });
          }
        );
      });
    }
  );
});

app.post('/packages/status-by-manifest/scan', requireAuth, requirePermission('packages', 'change_status'), (req, res) => {
  const companyId = getCompanyId(req);
  const status = normalizeString(req.body.status);
  const scanValue = normalizeString(req.body.scan_value);
  const redirectUrl = `/packages/status-by-manifest?status=${encodeURIComponent(status || '')}`;
  if (!companyId || !PACKAGE_STATUSES.includes(status) || !scanValue) {
    setFlash(req, 'error', res.locals.t('packages.status_manifest.flash_invalid'));
    return res.redirect(redirectUrl);
  }
  findPackagesTable((table) => {
    if (!table) {
      setFlash(req, 'error', res.locals.t('errors.server_try_again'));
      return res.redirect(redirectUrl);
    }
    db.get(
      `SELECT id FROM ${table} WHERE company_id = ? AND (internal_code = ? OR tracking_number = ?) LIMIT 1`,
      [companyId, scanValue, scanValue],
      (pkgErr, pkg) => {
        if (pkgErr || !pkg) {
          setFlash(req, 'error', res.locals.t('packages.status_manifest.flash_scan_not_found'));
          return res.redirect(redirectUrl);
        }
        const changedBy = req.session && req.session.user ? req.session.user.id : null;
        updatePackageStatusWithHistory(
          companyId,
          pkg.id,
          status,
          changedBy,
          'Actualizado por escaneo',
          (updateErr, didUpdate) => {
            if (updateErr) {
              setFlash(req, 'error', res.locals.t('errors.server_try_again'));
              return res.redirect(redirectUrl);
            }
            if (!didUpdate) {
              setFlash(req, 'info', res.locals.t('packages.status_manifest.flash_scan_unchanged', { status }));
              return res.redirect(redirectUrl);
            }
            setFlash(req, 'success', res.locals.t('packages.status_manifest.flash_scan_updated'));
            return res.redirect(redirectUrl);
          }
        );
      }
    );
  });
});

app.get('/packages/labels', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  return res.redirect('/settings/labels/packages');
});

app.get('/settings/labels/packages', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  getPackageLabelLayout(companyId, (labelLayout) => {
    res.render('packages-labels', { labelsContext: 'settings', labelLayout });
  });
});

app.post('/packages/labels/layout', requireAuth, requirePermission('packages', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const layout = req.body && typeof req.body === 'object' ? req.body : null;
  if (!layout) return res.status(400).json({ ok: false });
  savePackageLabelLayout(companyId, layout, (err) => {
    if (err) return res.status(500).json({ ok: false });
    return res.json({ ok: true });
  });
});

app.get('/packages/tracking', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  res.render('packages-tracking', { packagesNav: 'tracking' });
});

app.get('/packages/reports', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  res.render('packages-reports', { packagesNav: 'reports' });
});

app.get('/packages/invoice/upload/:token', (req, res) => {
  const data = verifyInvoiceUploadToken(req.params.token);
  if (!data) return res.status(404).send(res.locals.t('packages.pending_invoice.upload_invalid'));
  fetchPackageDetail(data.companyId, data.packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.status(404).send(res.locals.t('packages.pending_invoice.upload_invalid'));
    return res.render('package-invoice-upload', {
      pkg,
      token: req.params.token,
      error: null,
      success: null
    });
  });
});

app.post('/packages/invoice/upload/:token', packageUpload.single('invoice_file'), csrfMiddleware, (req, res) => {
  const data = verifyInvoiceUploadToken(req.params.token);
  if (!data) return res.status(404).send(res.locals.t('packages.pending_invoice.upload_invalid'));
  if (!req.file) {
    return fetchPackageDetail(data.companyId, data.packageId, (pkgErr, pkg) => {
      if (pkgErr || !pkg) return res.status(404).send(res.locals.t('packages.pending_invoice.upload_invalid'));
      return res.render('package-invoice-upload', {
        pkg,
        token: req.params.token,
        error: res.locals.t('packages.pending_invoice.upload_required'),
        success: null
      });
    });
  }
  findPackagesTable((table) => {
    if (!table) return res.status(404).send(res.locals.t('packages.pending_invoice.upload_invalid'));
    db.run(
      `UPDATE ${table} SET invoice_file = ?, invoice_status = ? WHERE id = ? AND company_id = ?`,
      [req.file.path, 'uploaded', data.packageId, data.companyId],
      () => {
        fetchPackageDetail(data.companyId, data.packageId, (pkgErr, pkg) => {
          if (pkgErr || !pkg) return res.status(404).send(res.locals.t('packages.pending_invoice.upload_invalid'));
          return res.render('package-invoice-upload', {
            pkg,
            token: req.params.token,
            error: null,
            success: res.locals.t('packages.pending_invoice.upload_success')
          });
        });
      }
    );
  });
});

app.get('/packages/new', requireAuth, requirePermission('packages', 'create'), (req, res) => {
  const companyId = getCompanyId(req);
  db.all(
    'SELECT id, customer_id, name FROM consignatarios WHERE company_id = ? ORDER BY name',
    [companyId],
    (err, consignatarios) => {
      const prefill = {
        tracking_number: normalizeString(req.query.tracking),
        carrier: normalizeString(req.query.carrier),
        reception_id: normalizeString(req.query.reception_id),
        received_at: normalizeString(req.query.received_at)
      };
      res.render('packages-new', {
        consignatarios: err ? [] : consignatarios || [],
        error: null,
        prefill,
        packagesNav: 'new'
      });
    }
  );
});

app.post('/packages/new', requireAuth, requirePermission('packages', 'create'), packageUpload.fields([
  { name: 'invoice_file', maxCount: 1 },
  { name: 'photos', maxCount: 10 }
]), csrfMiddleware, (req, res) => {
  const companyId = getCompanyId(req);
  const consignatarioId = Number(req.body.consignatario_id || 0);
  const trackingNumber = normalizeString(req.body.tracking_number);
  const carrier = normalizeString(req.body.carrier);
  const prefill = {
    tracking_number: trackingNumber,
    carrier,
    reception_id: normalizeString(req.body.reception_id),
    received_at: normalizeString(req.body.received_at)
  };

  const renderWithError = (message) => {
    db.all(
      'SELECT id, customer_id, name FROM consignatarios WHERE company_id = ? ORDER BY name',
      [companyId],
      (err, consignatarios) => {
        res.render('packages-new', {
          consignatarios: err ? [] : consignatarios || [],
          error: message,
          prefill,
          packagesNav: 'new'
        });
      }
    );
  };

  if (!consignatarioId || !trackingNumber) {
    return renderWithError(res.locals.t('errors.package_required_fields'));
  }

  resolveConsignatarioWithCustomer(consignatarioId, companyId, (consErr, consignatario) => {
    if (consErr || !consignatario) {
      return renderWithError(res.locals.t('errors.package_invalid_consignatario'));
    }
    getCustomerStatusById(consignatario.customer_id, companyId, (custErr, status) => {
      if (custErr || !status || !status.ok) {
        if (status && status.reason === 'voided') {
          return renderWithError(res.locals.t('errors.customer_voided_not_allowed'));
        }
        return renderWithError(res.locals.t('errors.package_invalid_consignatario'));
      }

      generateInternalCode(companyId, 0, (codeErr, internalCode) => {
        if (codeErr || !internalCode) {
          return renderWithError(res.locals.t('errors.package_create_failed'));
        }

        const paymentStatus = req.body.payment_status === 'paid' ? 'paid' : 'pending';
        let invoiceStatus = req.body.invoice_status === 'uploaded' ? 'uploaded' : 'pending';

        const invoiceFile = req.files && req.files.invoice_file ? req.files.invoice_file[0] : null;
        const photos = req.files && req.files.photos ? req.files.photos : [];
        const invoiceFilePath = invoiceFile ? invoiceFile.path : null;
        if (invoiceFilePath) invoiceStatus = 'uploaded';

        const status = PACKAGE_STATUSES[0];
        const receivedAt = normalizeString(req.body.received_at) || null;

        getPackageSenderSettings(companyId, (senderSettings) => {
          db.run(
            `INSERT INTO packages
             (internal_code, customer_id, consignatario_id, sender_name, store_name, description,
              delivery_address, delivery_municipality, delivery_department, delivery_phone,
              weight_lbs, length_cm, width_cm, height_cm, declared_value, shipping_type,
              branch_destination, delivery_type, payment_status, invoice_status, carrier,
              tracking_number, received_at, invoice_file, notes, status, company_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              internalCode,
              consignatario.customer_id || null,
              consignatario.id,
              senderSettings.sender_name || null,
              senderSettings.store_name || null,
              normalizeString(req.body.description) || null,
              normalizeString(consignatario.full_address) || null,
              normalizeString(consignatario.municipality) || null,
              normalizeString(consignatario.department) || null,
              normalizeString(consignatario.phone) || null,
              toNumberOrNull(req.body.weight_lbs),
              toNumberOrNull(req.body.length_cm),
              toNumberOrNull(req.body.width_cm),
              toNumberOrNull(req.body.height_cm),
              toNumberOrNull(req.body.declared_value),
              normalizeString(req.body.shipping_type) || null,
              normalizeString(req.body.branch_destination) || null,
              normalizeString(req.body.delivery_type) || null,
              paymentStatus,
              invoiceStatus,
              carrier || null,
              trackingNumber,
              receivedAt,
              invoiceFilePath,
              normalizeString(req.body.notes) || null,
              status,
              companyId
            ],
            function (err) {
              if (err) {
                return renderWithError(res.locals.t('errors.package_create_failed'));
              }
              const packageId = this.lastID;

              insertPackagePhotos(packageId, companyId, photos, () => {
                db.run(
                  `INSERT INTO package_status_history
                   (package_id, status, old_status, new_status, changed_by, notes, company_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [
                    packageId,
                    status,
                    null,
                    status,
                    req.session && req.session.user ? req.session.user.id : null,
                    null,
                    companyId
                  ]
                );

                const receptionId = Number(req.body.reception_id || 0);
                if (receptionId > 0) {
                  db.run(
                    `UPDATE carrier_receptions
                     SET status = 'processed', package_id = ?
                     WHERE id = ? AND company_id = ?`,
                    [packageId, receptionId, companyId]
                  );
                }

                return res.redirect(`/packages/${packageId}`);
              });
            }
          );
        });
      });
    });
  });
});

app.get('/packages/:id', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.redirect('/packages');
    fetchPackageHistory(packageId, (history) => {
      fetchPackageComments(packageId, (comments) => {
        db.all(
          'SELECT file_path, COALESCE(created_at, uploaded_at) AS photo_at FROM package_photos WHERE package_id = ? ORDER BY photo_at DESC',
          [packageId],
          (photoErr, photoRows) => {
            const photos = (photoErr ? [] : photoRows || []).map((row) => ({
              file_path: buildFileUrl(row.file_path)
            })).filter((row) => row.file_path);

            res.render('package-detail', {
              pkg,
              statuses: PACKAGE_STATUSES,
              history,
              photos,
              comments,
              error: null
            });
          }
        );
      });
    });
  });
});

app.get('/packages/:id/edit', requireAuth, requirePermission('packages', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.redirect('/packages');
    db.all(
      'SELECT id, customer_id, name FROM consignatarios WHERE company_id = ? ORDER BY name',
      [companyId],
      (consErr, consignatarios) => {
        res.render('package-edit', {
          pkg,
          consignatarios: consErr ? [] : consignatarios || [],
          statuses: PACKAGE_STATUSES,
          error: null
        });
      }
    );
  });
});

app.post('/packages/:id/update', requireAuth, requirePermission('packages', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.redirect('/packages');

    const renderEditWithError = (message) => {
      db.all(
        'SELECT id, customer_id, name FROM consignatarios WHERE company_id = ? ORDER BY name',
        [companyId],
        (consErr, consignatarios) => {
          res.render('package-edit', {
            pkg,
            consignatarios: consErr ? [] : consignatarios || [],
            statuses: PACKAGE_STATUSES,
            error: message
          });
        }
      );
    };

    const rawConsignatarioId = normalizeString(req.body.consignatario_id);
    const hasConsignatarioInput = rawConsignatarioId.length > 0;

    const finalizeUpdate = (customerId, consignatarioId, deliveryData) => {
      getPackageSenderSettings(companyId, (senderSettings) => {
        const senderName = senderSettings.sender_name != null ? senderSettings.sender_name : normalizeString(pkg.sender_name) || null;
        const storeName = senderSettings.store_name != null ? senderSettings.store_name : normalizeString(pkg.store_name) || null;
        db.run(
          `UPDATE packages
           SET customer_id = ?, consignatario_id = ?, sender_name = ?, store_name = ?, description = ?,
               delivery_address = ?, delivery_municipality = ?, delivery_department = ?, delivery_phone = ?,
               declared_value = ?, weight_lbs = ?, length_cm = ?, width_cm = ?, height_cm = ?, shipping_type = ?,
               branch_destination = ?, delivery_type = ?, payment_status = ?, invoice_status = ?, carrier = ?,
               tracking_number = ?, received_at = ?, notes = ?
           WHERE id = ? AND company_id = ?`,
          [
            customerId || null,
            consignatarioId || null,
            senderName,
            storeName,
            normalizeString(req.body.description) || null,
            deliveryData.address,
            deliveryData.municipality,
            deliveryData.department,
            deliveryData.phone,
            toNumberOrNull(req.body.declared_value),
            toNumberOrNull(req.body.weight_lbs),
            toNumberOrNull(req.body.length_cm),
            toNumberOrNull(req.body.width_cm),
            toNumberOrNull(req.body.height_cm),
            normalizeString(req.body.shipping_type) || null,
            normalizeString(req.body.branch_destination) || null,
            normalizeString(req.body.delivery_type) || null,
            req.body.payment_status === 'paid' ? 'paid' : 'pending',
            req.body.invoice_status === 'uploaded' ? 'uploaded' : 'pending',
            normalizeString(req.body.carrier) || null,
            normalizeString(req.body.tracking_number) || null,
            normalizeString(req.body.received_at) || null,
            normalizeString(req.body.notes) || null,
            packageId,
            companyId
          ],
          (err) => {
            if (err) return res.redirect(`/packages/${packageId}/edit`);
            return res.redirect(`/packages/${packageId}`);
          }
        );
      });
    };

    if (!hasConsignatarioInput) {
      const deliveryData = {
        address: normalizeString(pkg.delivery_address) || null,
        municipality: normalizeString(pkg.delivery_municipality) || null,
        department: normalizeString(pkg.delivery_department) || null,
        phone: normalizeString(pkg.delivery_phone) || null
      };
      return finalizeUpdate(pkg.customer_id, pkg.consignatario_id, deliveryData);
    }

    resolveConsignatarioWithCustomer(rawConsignatarioId, companyId, (consErr, consignatario) => {
      if (consErr || !consignatario) {
        return renderEditWithError(res.locals.t('errors.package_invalid_consignatario'));
      }
      getCustomerStatusById(consignatario.customer_id, companyId, (custErr, status) => {
        if (custErr || !status || !status.ok) {
          if (status && status.reason === 'voided') {
            return renderEditWithError(res.locals.t('errors.customer_voided_not_allowed'));
          }
          return renderEditWithError(res.locals.t('errors.package_invalid_consignatario'));
        }
        const deliveryData = {
          address: normalizeString(consignatario.full_address) || null,
          municipality: normalizeString(consignatario.municipality) || null,
          department: normalizeString(consignatario.department) || null,
          phone: normalizeString(consignatario.phone) || null
        };
        return finalizeUpdate(status.id, consignatario.id, deliveryData);
      });
    });
  });
});

app.post('/packages/:id/status', requireAuth, requirePermission('packages', 'change_status'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  const status = normalizeString(req.body.status);
  if (!Number.isInteger(packageId) || packageId <= 0 || !PACKAGE_STATUSES.includes(status)) {
    return res.redirect('/packages');
  }

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.redirect('/packages');

    db.run('UPDATE packages SET status = ? WHERE id = ? AND company_id = ?', [status, packageId, companyId], () => {
      db.run(
        `INSERT INTO package_status_history
         (package_id, status, old_status, new_status, changed_by, notes, company_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          packageId,
          status,
          pkg.status,
          status,
          req.session && req.session.user ? req.session.user.id : null,
          normalizeString(req.body.status_notes) || null,
          companyId
        ]
      );
      return res.redirect(`/packages/${packageId}`);
    });
  });
});

app.post('/packages/:id/invoice', requireAuth, requirePermission('packages', 'edit'), packageUpload.single('invoice_file'), csrfMiddleware, (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');
  if (!req.file) return res.redirect(`/packages/${packageId}`);

  db.run(
    'UPDATE packages SET invoice_file = ?, invoice_status = ? WHERE id = ? AND company_id = ?',
    [req.file.path, 'uploaded', packageId, companyId],
    () => res.redirect(`/packages/${packageId}`)
  );
});

app.post('/packages/:id/request-invoice/whatsapp', requireAuth, requirePermission('packages', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  const redirectUrl = req.get('referer') || '/packages/pending-invoice';
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect(redirectUrl);

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) {
      setFlash(req, 'error', res.locals.t('packages.pending_invoice.send_failed'));
      return res.redirect(redirectUrl);
    }
    const phone = pkg.customer_phone || pkg.consignatario_phone;
    if (!phone) {
      setFlash(req, 'error', res.locals.t('packages.pending_invoice.no_phone'));
      return res.redirect(redirectUrl);
    }
    const uploadUrl = buildPackageInvoiceUploadUrl(req, packageId, companyId);
    const message = buildInvoiceRequestMessage(pkg.tracking_number || pkg.internal_code, uploadUrl);
    sendWhatsappMessage(phone, message, (err) => {
      if (err) {
        setFlash(req, 'error', res.locals.t('packages.pending_invoice.send_failed'));
      } else {
        setFlash(req, 'success', res.locals.t('packages.pending_invoice.send_success'));
      }
      return res.redirect(redirectUrl);
    });
  });
});

app.post('/packages/:id/request-invoice/email', requireAuth, requirePermission('packages', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  const redirectUrl = req.get('referer') || '/packages/pending-invoice';
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect(redirectUrl);

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) {
      setFlash(req, 'error', res.locals.t('packages.pending_invoice.send_failed'));
      return res.redirect(redirectUrl);
    }
    const email = pkg.customer_email;
    if (!email) {
      setFlash(req, 'error', res.locals.t('packages.pending_invoice.no_email'));
      return res.redirect(redirectUrl);
    }
    const uploadUrl = buildPackageInvoiceUploadUrl(req, packageId, companyId);
    const message = buildInvoiceRequestMessage(pkg.tracking_number || pkg.internal_code, uploadUrl);
    const subject = res.locals.t('packages.pending_invoice.email_subject');
    sendInvoiceEmail(email, subject, message, (err) => {
      if (err) {
        setFlash(req, 'error', res.locals.t('packages.pending_invoice.send_failed'));
      } else {
        setFlash(req, 'success', res.locals.t('packages.pending_invoice.send_success'));
      }
      return res.redirect(redirectUrl);
    });
  });
});

app.post('/packages/:id/photos', requireAuth, requirePermission('packages', 'edit'), packageUpload.array('photos', 10), csrfMiddleware, (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');
  const files = req.files || [];
  insertPackagePhotos(packageId, companyId, files, () => res.redirect(`/packages/${packageId}`));
});

app.post('/packages/:id/comments', requireAuth, requirePermission('packages', 'edit'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  const comment = normalizeString(req.body.comment);
  if (!Number.isInteger(packageId) || packageId <= 0 || !comment) return res.redirect('/packages');

  db.run(
    'INSERT INTO package_comments (package_id, comment, created_by, company_id) VALUES (?, ?, ?, ?)',
    [packageId, comment, req.session && req.session.user ? req.session.user.id : null, companyId],
    () => res.redirect(`/packages/${packageId}`)
  );
});

app.get('/packages/:id/label', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.redirect('/packages');
    const labelData = buildPackageLabelData(pkg);
    const autoPrint = req.query.print === '1';
    const bwMode = req.query.bw === '1';
    const format = req.query.format;

    getCompanyBrandById(companyId, (companyBrand) => {
      getPackageLabelLayout(companyId, (labelLayout) => {
        const qrValue = buildPackageUrl(req, pkg.id);
        generateBarcodeDataUrl(pkg.internal_code || pkg.tracking_number, (barErr, barcodeDataUrl) => {
          generateQrDataUrl(qrValue, (qrErr, qrDataUrl) => {
            if (format === 'pdf') {
              const layout = labelLayout || null;
              const items = layout && Array.isArray(layout.items) ? layout.items : [];
              res.setHeader('Content-Type', 'application/pdf');

              if (!items.length) {
                const doc = new PDFDocument({ size: [288, 432], margin: 20 });
                doc.fontSize(16).text('Package Label', { align: 'center' });
                doc.moveDown();
                doc.fontSize(12).text(`CÃ³digo: ${pkg.internal_code || '-'}`);
                doc.text(`Tracking: ${pkg.tracking_number || '-'}`);
                doc.text(`Consignatario: ${pkg.consignatario_name || '-'}`);
                doc.text(`DirecciÃ³n: ${labelData.delivery_address || '-'}`);
                doc.text(`Municipio: ${labelData.delivery_municipality || '-'}`);
                doc.text(`Departamento: ${labelData.delivery_department || '-'}`);
                doc.text(`TelÃ©fono: ${labelData.delivery_phone || '-'}`);
                doc.text(`Peso: ${pkg.weight_lbs || '-'} lbs`);
                doc.text(`Estado: ${pkg.status || '-'}`);
                doc.end();
                return;
              }

              const sizeMap = {
                standard: { width: 560, height: 320 },
                compact: { width: 480, height: 280 },
                square: { width: 360, height: 360 },
                large: { width: 720, height: 420 }
              };
              const sizeKey = layout && layout.size ? layout.size : 'standard';
              const size = sizeMap[sizeKey] || sizeMap.standard;
              const canvasWidth = size.width;
              const canvasHeight = size.height;
              const canvasPadding = 14;
              const doc = new PDFDocument({ size: [canvasWidth, canvasHeight], margin: 0 });
              const shapeDefs = {
                'shape-line': { type: 'line-h', width: 180, height: 2, stroke: 1 },
                'shape-line-vertical': { type: 'line-v', width: 2, height: 110, stroke: 1 },
                'shape-rect': { type: 'rect', width: 160, height: 90, stroke: 1 },
                'shape-circle': { type: 'circle', width: 70, height: 70, stroke: 1 }
              };

              const logoValue = layout && layout.logo ? layout.logo : (companyBrand && companyBrand.logo) || null;
              const nameValue = layout && layout.name ? layout.name : (companyBrand && companyBrand.name) || 'Empresa';
              const addressValue =
                layout && layout.address ? layout.address : labelData.delivery_address || '-';

              const valueForField = (fieldKey) => {
                switch (fieldKey) {
                  case 'logo':
                    return logoValue;
                  case 'name':
                    return nameValue;
                  case 'address':
                    return addressValue;
                  case 'tracking':
                    return pkg.tracking_number || '-';
                  case 'consignatario':
                    return pkg.consignatario_name || '-';
                  case 'municipio':
                    return labelData.delivery_municipality || '-';
                  case 'departamento':
                    return labelData.delivery_department || '-';
                  case 'telefono':
                    return labelData.delivery_phone || '-';
                  case 'peso':
                    return pkg.weight_lbs ? Number(pkg.weight_lbs).toFixed(2) + ' lbs' : '-';
                  case 'dimensiones':
                    return `${pkg.length_cm || '-'} x ${pkg.width_cm || '-'} x ${pkg.height_cm || '-'}`;
                  case 'carrier':
                    return pkg.carrier || '-';
                  case 'status':
                    return pkg.status || '-';
                  case 'recibido':
                    return pkg.received_at || '-';
                  case 'internal':
                    return pkg.internal_code || '-';
                  case 'barcode':
                    return barcodeDataUrl || null;
                  case 'qr':
                    return qrDataUrl || null;
                  default:
                    return '-';
                }
              };

                items.forEach((item) => {
                  const left = Number.isFinite(Number(item.left)) ? Number(item.left) : 0;
                  const top = Number.isFinite(Number(item.top)) ? Number(item.top) : 0;
                  const drawLeft = left + canvasPadding;
                  const drawTop = top + canvasPadding;
                  const fieldKey = item.field;
                  const itemText = typeof item.text === 'string' ? item.text : '';
                  const value = fieldKey === 'free-text' ? itemText : valueForField(fieldKey);
                  const shape = shapeDefs[fieldKey];
                  const shapeColor =
                    typeof item.color === 'string' && item.color.trim().length ? item.color.trim() : '#111111';
                  const shapeThickness = Number(item.thickness) || 2;

                if (shape) {
                  doc.save();
                  doc.lineWidth(shapeThickness).strokeColor(shapeColor);
                  if (shape.type === 'line-h') {
                    const y = drawTop + (shape.height / 2);
                    doc.moveTo(drawLeft, y).lineTo(drawLeft + shape.width, y).stroke();
                  } else if (shape.type === 'line-v') {
                    const x = drawLeft + (shape.width / 2);
                    doc.moveTo(x, drawTop).lineTo(x, drawTop + shape.height).stroke();
                  } else if (shape.type === 'rect') {
                    doc.rect(drawLeft, drawTop, shape.width, shape.height).stroke();
                  } else if (shape.type === 'circle') {
                    const radius = shape.width / 2;
                    doc.circle(drawLeft + radius, drawTop + radius, radius).stroke();
                  }
                  doc.restore();
                  return;
                }

                if (fieldKey === 'logo' && value) {
                  const img = Buffer.from(String(value).split(',')[1] || '', 'base64');
                  if (img.length) doc.image(img, drawLeft, drawTop, { width: 42, height: 42 });
                  return;
                }
                if (fieldKey === 'barcode' && value) {
                  const img = Buffer.from(String(value).split(',')[1] || '', 'base64');
                  if (img.length) doc.image(img, drawLeft, drawTop, { width: 140, height: 38 });
                  return;
                }
                if (fieldKey === 'qr' && value) {
                  const img = Buffer.from(String(value).split(',')[1] || '', 'base64');
                  if (img.length) doc.image(img, drawLeft, drawTop, { width: 72, height: 72 });
                  return;
                }
                doc.fontSize(9).text(String(value || ''), drawLeft, drawTop, { lineBreak: false });
              });

              doc.end();
              return;
            }

            res.render('package-label', {
              pkg,
              labelData,
              companyBrand,
              barcodeDataUrl,
              qrDataUrl,
              autoPrint,
              bwMode,
              labelLayout
            });
          });
        });
      });
    });
  });
});

app.get('/packages/:id/receipt', requireAuth, requirePermission('packages', 'view'), (req, res) => {
  const companyId = getCompanyId(req);
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId <= 0) return res.redirect('/packages');

  fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
    if (pkgErr || !pkg) return res.redirect('/packages');
    return res.render('package-receipt', { pkg });
  });
});

app.post('/packages/bulk-status', requireAuth, requirePermission('packages', 'change_status'), (req, res) => {
  const companyId = getCompanyId(req);
  const status = normalizeString(req.body.status);
  const rawIds = req.body.package_ids || req.body['package_ids[]'] || [];
  const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
  const validIds = ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);

  if (!validIds.length || !PACKAGE_STATUSES.includes(status)) {
    return res.redirect('/packages');
  }

  const updateNext = (index) => {
    if (index >= validIds.length) return res.redirect('/packages');
    const packageId = validIds[index];
    fetchPackageDetail(companyId, packageId, (pkgErr, pkg) => {
      if (pkgErr || !pkg) return updateNext(index + 1);
      db.run('UPDATE packages SET status = ? WHERE id = ? AND company_id = ?', [status, packageId, companyId], () => {
        db.run(
          `INSERT INTO package_status_history
           (package_id, status, old_status, new_status, changed_by, notes, company_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            packageId,
            status,
            pkg.status,
            status,
            req.session && req.session.user ? req.session.user.id : null,
            null,
            companyId
          ],
          () => updateNext(index + 1)
        );
      });
    });
  };

  return updateNext(0);
});

app.post('/packages/labels/print', requireAuth, requirePermission('packages', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const rawIds = req.body.package_ids || req.body['package_ids[]'] || [];
  const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
  const validIds = ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!validIds.length) return res.redirect('/packages');

  const placeholders = validIds.map(() => '?').join(',');
  const params = [companyId, ...validIds];
  const sql = `SELECT p.*,
            c.name AS customer_name,
            c.customer_code AS customer_code,
            cons.name AS consignatario_name,
            cons.full_address AS consignatario_address,
            cons.municipality AS consignatario_municipality,
            cons.department AS consignatario_department,
            cons.phone AS consignatario_phone
     FROM packages p
     LEFT JOIN customers c ON c.id = p.customer_id AND c.company_id = p.company_id
     LEFT JOIN consignatarios cons ON cons.id = p.consignatario_id AND cons.company_id = p.company_id
     WHERE p.company_id = ? AND p.id IN (${placeholders})
     ORDER BY p.created_at DESC`;

  db.all(sql, params, (err, rows) => {
    const packages = err ? [] : rows || [];
    if (!packages.length) return res.redirect('/packages');

    getCompanyBrandById(companyId, (companyBrand) => {
      getPackageLabelLayout(companyId, (labelLayout) => {
        const labels = [];
        const buildNext = (index) => {
          if (index >= packages.length) {
            return res.render('package-label-batch', {
              labels,
              companyBrand,
              autoPrint: true,
              labelLayout
            });
          }
          const pkg = packages[index];
          const labelData = buildPackageLabelData(pkg);
          const qrValue = buildPackageUrl(req, pkg.id);
          generateBarcodeDataUrl(pkg.internal_code || pkg.tracking_number, (barErr, barcodeDataUrl) => {
            generateQrDataUrl(qrValue, (qrErr, qrDataUrl) => {
              labels.push({ pkg, labelData, barcodeDataUrl, qrDataUrl });
              return buildNext(index + 1);
            });
          });
        };
        return buildNext(0);
      });
    });
  });
});

app.get('/packages/export', requireAuth, requirePermission('packages', 'export'), (req, res) => {
  const companyId = getCompanyId(req);
  const filters = {
    q: normalizeString(req.query.q),
    status: normalizeString(req.query.status),
    customer: normalizeString(req.query.customer),
    carrier: normalizeString(req.query.carrier),
    received_date: normalizeString(req.query.received_date)
  };
  fetchPackagesList(companyId, filters, (err, packages) => {
    if (err) return res.redirect('/packages');
    const csv = stringify(packages || [], {
      header: true,
      columns: [
        { key: 'internal_code', header: 'internal_code' },
        { key: 'tracking_number', header: 'tracking_number' },
        { key: 'customer_code', header: 'customer_code' },
        { key: 'customer_name', header: 'customer' },
        { key: 'consignatario_name', header: 'consignatario' },
        { key: 'description', header: 'description' },
        { key: 'weight_lbs', header: 'weight_lbs' },
        { key: 'carrier', header: 'carrier' },
        { key: 'status', header: 'status' },
        { key: 'payment_status', header: 'payment_status' },
        { key: 'invoice_status', header: 'invoice_status' },
        { key: 'received_at', header: 'received_at' }
      ]
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="packages.csv"');
    return res.send(csv);
  });
});

}
module.exports = {
  registerPackageRoutes
};
