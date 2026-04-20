(function () {
  function parseTime(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return (hours * 60) + minutes;
  }

  function hoursBetween(start, end) {
    const startValue = parseTime(start);
    const endValue = parseTime(end);
    if (startValue === null || endValue === null || endValue <= startValue) return 0;
    return (endValue - startValue) / 60;
  }

  function initOvertimeForms() {
    document.querySelectorAll('[data-hr-hours-form]').forEach((form) => {
      const startInput = form.querySelector('[data-hr-start]');
      const endInput = form.querySelector('[data-hr-end]');
      const totalInput = form.querySelector('[data-hr-total]');
      if (!startInput || !endInput || !totalInput) return;

      const sync = () => {
        totalInput.value = hoursBetween(startInput.value, endInput.value).toFixed(2);
      };

      startInput.addEventListener('input', sync);
      endInput.addEventListener('input', sync);
      sync();
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildContractText(employee, values) {
    const employeeName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
    const lines = [
      'CONTRATO INDIVIDUAL DE TRABAJO',
      '',
      'Entre las partes comparecen, por una parte, LA EMPRESA, y por la otra, EL TRABAJADOR, quienes convienen celebrar el presente contrato individual de trabajo sujeto a las cláusulas siguientes:',
      '',
      `PRIMERA. IDENTIFICACIÓN DEL TRABAJADOR: ${employeeName || 'N/D'}, identificado con DPI ${employee.dpi_number || 'N/D'}, con domicilio en ${employee.address || 'N/D'}.`,
      `SEGUNDA. PUESTO Y ADSCRIPCIÓN: El trabajador prestará sus servicios como ${employee.position || values.contract_type || 'Colaborador'} en el departamento de ${employee.department || 'General'}.`,
      `TERCERA. FECHA DE INICIO: Las labores iniciarán el ${values.start_date || 'N/D'}${values.end_date ? ` y concluirán el ${values.end_date}` : ', con duración indefinida hasta nueva disposición contractual'}.`,
      `CUARTA. JORNADA: La jornada se desarrollará bajo el horario ${values.work_schedule || 'según necesidades de la empresa'} y modalidad ${values.workday_type || 'ordinaria'}.`,
      `QUINTA. REMUNERACIÓN: La empresa pagará un salario base de Q${Number(values.salary || 0).toFixed(2)} y bono de Q${Number(values.bonus_amount || 0).toFixed(2)}.`,
      `SEXTA. CENTRO DE TRABAJO: El trabajador prestará sus servicios en ${values.workplace || 'las instalaciones que la empresa designe'}.`,
      `SÉPTIMA. PERÍODO DE PRUEBA: ${values.probation_period || 'No aplica'}.`,
      `OCTAVA. FUNCIONES PRINCIPALES: ${values.main_functions || 'Las propias del puesto y las que sean afines a la naturaleza del cargo.'}`,
      `NOVENA. JEFE INMEDIATO: ${employee.immediate_boss_name || 'Según organigrama vigente de la empresa'}.`,
      `DÉCIMA. CLÁUSULAS ADICIONALES: ${values.extra_clauses || 'Las partes se obligan a cumplir con el reglamento interno, políticas de la empresa y demás normativa aplicable.'}`,
      `DÉCIMA PRIMERA. OBSERVACIONES: ${values.observations || 'Sin observaciones adicionales.'}`,
      '',
      'Leído que fue el presente contrato y enteradas las partes de su contenido y alcance legal, lo firman en señal de aceptación.',
      '',
      '______________________________',
      'Representante de la empresa',
      '',
      '______________________________',
      employeeName || 'Trabajador'
    ];
    return lines.join('\n');
  }

  function initContractForm() {
    const form = document.querySelector('[data-contract-form]');
    if (!form) return;

    const employeesNode = document.getElementById('hr-employees-json');
    let employees = [];
    if (employeesNode) {
      try {
        employees = JSON.parse(employeesNode.textContent || '[]');
      } catch (err) {
        employees = [];
      }
    }

    const employeeSelect = form.querySelector('[data-contract-employee]');
    const preview = form.querySelector('[data-contract-preview]');
    const textarea = form.querySelector('[data-contract-text]');
    const trackedFields = Array.from(form.querySelectorAll('[data-contract-field]'));
    if (!employeeSelect || !preview || !textarea) return;

    let lastAutoText = textarea.value || '';

    function currentEmployee() {
      return employees.find((entry) => String(entry.id) === String(employeeSelect.value)) || {};
    }

    function fieldValues() {
      const values = {};
      trackedFields.forEach((field) => {
        values[field.getAttribute('data-contract-field')] = field.value || '';
      });
      return values;
    }

    function renderPreview(text) {
      preview.innerHTML = String(text || '')
        .split('\n')
        .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : '<br />'))
        .join('');
    }

    function syncContractText() {
      const generated = buildContractText(currentEmployee(), fieldValues());
      if (!textarea.value || textarea.value === lastAutoText) {
        textarea.value = generated;
      }
      lastAutoText = generated;
      renderPreview(textarea.value || generated);
    }

    employeeSelect.addEventListener('change', syncContractText);
    trackedFields.forEach((field) => field.addEventListener('input', syncContractText));
    textarea.addEventListener('input', () => {
      renderPreview(textarea.value);
    });
    syncContractText();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initOvertimeForms();
    initContractForm();
  });
})();
