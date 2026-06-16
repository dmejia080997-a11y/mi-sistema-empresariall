const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const outputPath = path.join(__dirname, '..', 'docs', 'flujo-produccion-manufactura.pdf');

function section(doc, title) {
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text(title);
  doc.moveDown(0.25);
  doc.strokeColor('#d1d5db').lineWidth(1).moveTo(doc.x, doc.y).lineTo(540, doc.y).stroke();
  doc.moveDown(0.6);
}

function paragraph(doc, text) {
  doc.font('Helvetica').fontSize(10.5).fillColor('#374151').text(text, {
    align: 'left',
    lineGap: 2
  });
  doc.moveDown(0.45);
}

function bullet(doc, text) {
  doc.font('Helvetica').fontSize(10.5).fillColor('#374151').text(`- ${text}`, {
    indent: 12,
    hangingIndent: 8,
    lineGap: 2
  });
  doc.moveDown(0.2);
}

function step(doc, number, title, body, bullets = []) {
  doc.moveDown(0.45);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#111827').text(`${number}. ${title}`);
  doc.moveDown(0.2);
  paragraph(doc, body);
  bullets.forEach((item) => bullet(doc, item));
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const doc = new PDFDocument({
  size: 'LETTER',
  margin: 54,
  info: {
    Title: 'Flujo de Produccion y Manufactura',
    Author: 'Mi Sistema Empresarial'
  }
});

doc.pipe(fs.createWriteStream(outputPath));

doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text('Flujo del Modulo de Produccion y Manufactura');
doc.moveDown(0.25);
doc.font('Helvetica').fontSize(10).fillColor('#64748b').text('Guia operativa basada en el modulo actual del sistema.');
doc.moveDown(1);

section(doc, 'Resumen');
paragraph(doc, 'El modulo convierte materia prima e insumos en producto terminado. Controla formulas BOM, ordenes de produccion, reservas, consumos de inventario, mano de obra, costos indirectos, merma, costos reales y entrada de producto terminado.');

section(doc, 'Flujo Operativo');
step(doc, 1, 'Clasificar productos', 'Primero se prepara el catalogo de inventario desde Produccion > Materiales.', [
  'Materia prima',
  'Insumo',
  'Material de empaque',
  'Producto en proceso',
  'Producto terminado'
]);

step(doc, 2, 'Crear formula o BOM', 'La BOM define que materiales se necesitan para fabricar un producto terminado.', [
  'Producto terminado a fabricar',
  'Codigo, nombre y version de la formula',
  'Cantidad base y unidad',
  'Materiales requeridos',
  'Cantidad de cada material',
  'Porcentaje de merma esperado'
]);

step(doc, 3, 'Crear orden de produccion', 'La orden se crea seleccionando producto, BOM y cantidad planificada. El sistema genera un numero tipo OP-0001 y copia los materiales de la BOM hacia la orden.', [
  'Estado inicial: Borrador',
  'Calcula cantidad requerida por material',
  'Calcula costo estimado con base en la BOM'
]);

step(doc, 4, 'Reservar materiales', 'La reserva valida si hay existencia suficiente y separa los materiales para esa orden. En esta etapa todavia no se descuenta inventario.', [
  'Si alcanza el stock, los materiales quedan reservados',
  'La orden pasa normalmente a Pendiente',
  'El disponible real considera otras reservas activas'
]);

step(doc, 5, 'Iniciar produccion', 'Al iniciar, el sistema consume los materiales requeridos y los descuenta del inventario.', [
  'Descuenta materia prima',
  'Registra movimiento de inventario production_consume',
  'Marca materiales como consumidos',
  'Guarda fecha real de inicio',
  'Cambia estado a En produccion'
]);

step(doc, 6, 'Registrar mano de obra', 'Dentro de la orden se agregan horas trabajadas y costo por hora. Puede tomarse un empleado de RRHH o escribirse manualmente.', [
  'Trabajador',
  'Horas',
  'Costo hora',
  'Total de mano de obra'
]);

step(doc, 7, 'Registrar costos indirectos CIF', 'Se agregan costos indirectos de fabricacion como energia, alquiler, depreciacion o mantenimiento.', [
  'Costo por orden',
  'Costo por unidad',
  'Costo por porcentaje',
  'Costo manual'
]);

step(doc, 8, 'Registrar merma o desperdicio', 'La merma descuenta inventario, registra el costo del desperdicio y suma ese costo al costo real de la orden.', [
  'Corte incorrecto',
  'Dano de material',
  'Producto defectuoso',
  'Ajuste normal',
  'Otro'
]);

step(doc, 9, 'Finalizar produccion', 'Se ingresa la cantidad producida. El sistema permite finalizaciones parciales y finales.', [
  'Aumenta inventario del producto terminado',
  'Registra movimiento production_finish',
  'Calcula costo real total',
  'Calcula costo unitario',
  'Actualiza costo promedio y ultimo costo del producto',
  'Si se completo la cantidad planificada, la orden queda Finalizada'
]);

section(doc, 'Estados de la Orden');
['Borrador', 'Pendiente', 'En produccion', 'Pausada', 'Finalizada', 'Cancelada'].forEach((item) => bullet(doc, item));

section(doc, 'Ruta Normal');
paragraph(doc, 'Borrador -> Reservar materiales -> Pendiente -> Iniciar produccion -> En produccion -> Registrar mano de obra / CIF / merma -> Finalizar parcial o total -> Finalizada');

section(doc, 'Calculo de Costos');
paragraph(doc, 'Costo real de produccion = materiales consumidos + mano de obra + costos indirectos CIF + merma.');
paragraph(doc, 'Costo unitario = costo real total / cantidad producida.');
paragraph(doc, 'Ese costo unitario se usa para ingresar el producto terminado al inventario y actualizar el costo promedio del producto.');

section(doc, 'Pantallas Principales');
[
  '/production - Dashboard',
  '/production/orders - Ordenes de produccion',
  '/production/orders/new - Nueva orden',
  '/production/bom - Formulas BOM',
  '/production/materials - Catalogo de materia prima e insumos',
  '/production/work-in-process - Producto en proceso',
  '/production/finished-goods - Producto terminado',
  '/production/waste - Merma o desperdicio',
  '/production/reports - Reportes de produccion'
].forEach((item) => bullet(doc, item));

section(doc, 'Integraciones');
paragraph(doc, 'El modulo se conecta con inventario para descontar materias primas e ingresar producto terminado. Tambien usa RRHH para costear mano de obra cuando se selecciona un empleado, y permisos de usuario para controlar quien puede ver, crear, editar, iniciar, finalizar, cancelar y ver costos.');

doc.end();

doc.on('end', () => {
  console.log(outputPath);
});
