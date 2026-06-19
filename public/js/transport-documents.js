(function () {
  const select = document.querySelector('[data-document-type]');
  const form = select ? select.closest('form') : null;
  if (!select || !form) return;

  const config = {
    bl: {
      title: 'Bill of Lading',
      subtitle: 'Documento maritimo',
      number: 'BL-0001',
      origin: 'Puerto de carga',
      destination: 'Puerto de descarga',
      carrier: 'Naviera',
      trip: 'Viaje / buque'
    },
    awb: {
      title: 'Air Waybill',
      subtitle: 'Documento aereo',
      number: '123-45678901',
      origin: 'Aeropuerto de salida',
      destination: 'Aeropuerto de destino',
      carrier: 'Aerolinea',
      trip: 'Vuelo'
    },
    carta_porte: {
      title: 'Carta porte',
      subtitle: 'Documento terrestre',
      number: 'CP-0001',
      origin: 'Lugar de carga',
      destination: 'Lugar de entrega',
      carrier: 'Transportista',
      trip: 'Unidad / ruta'
    }
  };

  const setLabel = (name, text) => {
    const input = form.querySelector(`[name="${name}"]`);
    const label = input ? input.closest('label') : null;
    if (!label) return;
    const firstText = Array.from(label.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (firstText) firstText.textContent = `\n${text}\n`;
  };

  const applyStyle = () => {
    const current = config[select.value] || config.awb;
    form.dataset.transportDocType = select.value;
    const title = form.querySelector('.awb-paper-title');
    const subtitle = form.querySelector('.awb-paper-sub');
    const number = form.querySelector('[name="awb_number"]');
    if (title) title.textContent = current.title;
    if (subtitle && !subtitle.querySelector('strong')) subtitle.textContent = current.subtitle;
    if (number) number.placeholder = current.number;
    setLabel('airport_of_departure', current.origin);
    setLabel('airport_of_destination', current.destination);
    setLabel('issuing_carrier', current.carrier);
    setLabel('flight_number', current.trip);
  };

  select.addEventListener('change', applyStyle);
  applyStyle();
})();
