export const DATA_VERSION = 2;

export const STATUSES = [
  { id: 'costura', label: 'En costura' },
  { id: 'terminado', label: 'Terminado' }
];

export const STATUS_IDS = STATUSES.map((status) => status.id);

export const PROCESSES = [
  { id: 'recta', label: 'Recta' },
  { id: 'over', label: 'Over' },
  { id: 'galonera', label: 'Galonera' },
  { id: 'trenzado', label: 'Trenzado' },
  { id: 'revolcado', label: 'Revolcado' },
  { id: 'empaquetado', label: 'Empaquetado' }
];

export const PROCESS_IDS = PROCESSES.map((process) => process.id);
export const PROCESS_ORDER = new Map(PROCESSES.map((process, index) => [process.id, index]));

export const ASSIGNMENT_STATUSES = [
  { id: 'pendiente', label: 'Pendiente' },
  { id: 'en_proceso', label: 'En proceso' },
  { id: 'terminado', label: 'Terminado' }
];

export const ASSIGNMENT_STATUS_IDS = ASSIGNMENT_STATUSES.map((status) => status.id);

const MAX_COLORS = 20;
const MAX_SIZES = 30;
const MAX_WORKERS = 300;
const MAX_WORKER_LENGTH = 80;
const MAX_QUANTITY = 999999;

export function statusLabel(id) {
  const found = STATUSES.find((status) => status.id === id);
  return found ? found.label : id;
}

export function processLabel(id) {
  const found = PROCESSES.find((process) => process.id === id);
  return found ? found.label : id;
}

export function assignmentStatusLabel(id) {
  const found = ASSIGNMENT_STATUSES.find((status) => status.id === id);
  return found ? found.label : id;
}

export function todayISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function formatDate(value) {
  if (!isValidISODate(value)) return value || 'Sin fecha';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function suggestNextNumero(fichas) {
  let max = 0;
  for (const ficha of fichas) {
    const value = String(ficha?.numero ?? '').trim();
    if (/^\d+$/.test(value)) {
      max = Math.max(max, Number.parseInt(value, 10));
    }
  }
  return String(max + 1);
}

export function computeTotal(tallas) {
  return (Array.isArray(tallas) ? tallas : []).reduce((sum, item) => {
    const quantity = Number(item?.cantidad);
    return sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0);
  }, 0);
}

export function computeColorTotal(color) {
  return computeTotal(color?.tallas);
}

export function computeFichaTotal(colores) {
  return (Array.isArray(colores) ? colores : []).reduce((sum, color) => sum + computeColorTotal(color), 0);
}

export function createEmptyProcesos() {
  return Object.fromEntries(PROCESS_IDS.map((id) => [id, []]));
}

export function tallasSummary(tallas, maxItems = 3) {
  const rows = Array.isArray(tallas) ? tallas.filter((row) => row?.talla) : [];
  const shown = rows.slice(0, maxItems).map((row) => `${row.talla}: ${row.cantidad}`);
  const remaining = rows.length - shown.length;
  return remaining > 0 ? `${shown.join(' · ')} +${remaining}` : shown.join(' · ');
}

export function tallasFull(tallas) {
  return (Array.isArray(tallas) ? tallas : [])
    .filter((row) => row?.talla)
    .map((row) => `${row.talla}: ${row.cantidad}`)
    .join(' | ');
}

export function colorNames(colores) {
  return (Array.isArray(colores) ? colores : []).map((color) => color?.color).filter(Boolean).join(', ');
}

export function coloresSummary(colores, maxColors = 2, maxSizes = 2) {
  const rows = Array.isArray(colores) ? colores.filter((color) => color?.color) : [];
  const shown = rows.slice(0, maxColors).map((color) => `${color.color}: ${tallasSummary(color.tallas, maxSizes)}`);
  const remaining = rows.length - shown.length;
  return remaining > 0 ? `${shown.join(' · ')} +${remaining} color${remaining === 1 ? '' : 'es'}` : shown.join(' · ');
}

export function coloresFull(colores) {
  return (Array.isArray(colores) ? colores : [])
    .filter((color) => color?.color)
    .map((color) => `${color.color}: ${tallasFull(color.tallas)}`)
    .join(' / ');
}

function sanitizeWorkers(rawWorkers) {
  const source = Array.isArray(rawWorkers) ? rawWorkers : [];
  const workers = [];
  const seen = new Set();
  for (const raw of source) {
    const worker = String(raw ?? '').trim();
    if (!worker || worker.length > MAX_WORKER_LENGTH) continue;
    const key = normalize(worker);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    workers.push(worker);
    if (workers.length >= MAX_WORKERS) break;
  }
  return workers;
}

export { sanitizeWorkers };

function sanitizeTallas(rawTallas, errors, colorIndex) {
  const source = Array.isArray(rawTallas) ? rawTallas : [];
  const tallas = [];
  const seen = new Set();

  source.forEach((row, index) => {
    const key = `talla_${colorIndex}_${index}`;
    const talla = String(row?.talla ?? '').trim();
    const rawQuantity = row?.cantidad;
    const quantity = rawQuantity === '' || rawQuantity === null || rawQuantity === undefined ? 0 : Number(rawQuantity);

    if (!talla && (rawQuantity === '' || rawQuantity === null || rawQuantity === undefined || quantity === 0)) return;

    if (!talla) {
      errors[key] = 'Escribe la talla.';
      return;
    }
    if (talla.length > 20) {
      errors[key] = 'La talla no puede pasar de 20 caracteres.';
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      errors[key] = 'La cantidad debe ser un número entero.';
      return;
    }
    if (quantity > MAX_QUANTITY) {
      errors[key] = 'La cantidad es demasiado grande.';
      return;
    }
    if (quantity === 0) return;

    const sizeKey = normalize(talla);
    if (seen.has(sizeKey)) {
      errors[key] = `La talla ${talla} está repetida en este color.`;
      return;
    }
    seen.add(sizeKey);
    tallas.push({ talla, cantidad: quantity });
  });

  if (tallas.length > MAX_SIZES) {
    errors[`tallas_${colorIndex}`] = `Un color no puede tener más de ${MAX_SIZES} tallas.`;
    return tallas.slice(0, MAX_SIZES);
  }
  if (tallas.length === 0) {
    errors[`tallas_${colorIndex}`] = 'Agrega al menos una talla con cantidad mayor que 0.';
  }
  return tallas;
}

function sanitizeProcesos(rawProcesos, total, colorIndex, errors, usedAssignmentIds) {
  const procesos = createEmptyProcesos();
  const source = rawProcesos && typeof rawProcesos === 'object' && !Array.isArray(rawProcesos) ? rawProcesos : {};

  for (const process of PROCESSES) {
    const rows = Array.isArray(source[process.id]) ? source[process.id] : [];
    let assigned = 0;

    rows.forEach((row, index) => {
      const key = `asignacion_${colorIndex}_${process.id}_${index}`;
      const rawWorker = row?.trabajador;
      const rawQuantity = row?.cantidad;
      const rawStatus = row?.estado;
      const worker = String(rawWorker ?? '').trim();
      const quantity = rawQuantity === '' || rawQuantity === null || rawQuantity === undefined ? 0 : Number(rawQuantity);
      const completelyEmpty = !worker
        && (rawQuantity === '' || rawQuantity === null || rawQuantity === undefined || quantity === 0);

      if (completelyEmpty) return;

      if (!worker) {
        errors[key] = 'Escribe el trabajador.';
        return;
      }
      if (worker.length > MAX_WORKER_LENGTH) {
        errors[key] = 'El nombre del trabajador es demasiado largo.';
        return;
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors[key] = 'La cantidad debe ser un número entero mayor que 0.';
        return;
      }
      if (quantity > MAX_QUANTITY) {
        errors[key] = 'La cantidad es demasiado grande.';
        return;
      }
      if (!ASSIGNMENT_STATUS_IDS.includes(rawStatus ?? 'pendiente')) {
        errors[key] = 'Elige un estado válido.';
        return;
      }

      assigned += quantity;
      let id = String(row?.id ?? '').trim();
      if (!id || usedAssignmentIds.has(id)) id = uid();
      while (usedAssignmentIds.has(id)) id = uid();
      usedAssignmentIds.add(id);
      procesos[process.id].push({
        id,
        trabajador: worker,
        cantidad: quantity,
        estado: rawStatus ?? 'pendiente'
      });
    });

    if (assigned > total) {
      errors[`proceso_${colorIndex}_${process.id}`] = `La suma de ${process.label} (${assigned}) supera las ${total} piezas del color.`;
    }
  }

  return procesos;
}

export function sanitizeFicha(input, options = {}) {
  const fichas = Array.isArray(options.fichas) ? options.fichas : [];
  const currentId = options.currentId ?? null;
  const errors = {};

  const numero = String(input?.numero ?? '').trim();
  if (!numero) {
    errors.numero = 'Escribe el número de ficha.';
  } else if (numero.length > 40) {
    errors.numero = 'El número no puede pasar de 40 caracteres.';
  } else if (fichas.some((ficha) => ficha.id !== currentId && normalize(ficha.numero) === normalize(numero))) {
    errors.numero = 'Ya existe una ficha con ese número.';
  }

  const fecha = String(input?.fecha ?? '').trim();
  if (!fecha) {
    errors.fecha = 'Elige la fecha.';
  } else if (!isValidISODate(fecha)) {
    errors.fecha = 'La fecha no es válida.';
  }

  const modelo = String(input?.modelo ?? '').trim();
  if (!modelo) {
    errors.modelo = 'Escribe el modelo.';
  } else if (modelo.length > 120) {
    errors.modelo = 'El modelo no puede pasar de 120 caracteres.';
  }

  const notas = String(input?.notas ?? '').trim();
  if (notas.length > 2000) {
    errors.notas = 'Las notas no pueden pasar de 2000 caracteres.';
  }

  const estado = STATUS_IDS.includes(input?.estado) ? input.estado : 'costura';

  let rawColores = Array.isArray(input?.colores) ? input.colores : [];
  if (rawColores.length === 0 && Array.isArray(input?.tallas)) {
    rawColores = [{
      color: String(input?.color ?? '').trim() || 'Sin color',
      tallas: input.tallas,
      procesos: input.procesos ?? {}
    }];
  }

  if (rawColores.length === 0) {
    errors.colores = 'Agrega al menos un color.';
  } else if (rawColores.length > MAX_COLORS) {
    errors.colores = `Una ficha no puede tener más de ${MAX_COLORS} colores.`;
  }

  const colores = [];
  const usedColorIds = new Set();
  const usedColorNames = new Set();
  const usedAssignmentIds = new Set();

  rawColores.slice(0, MAX_COLORS).forEach((rawColor, index) => {
    const colorName = String(rawColor?.color ?? '').trim();
    if (!colorName) {
      errors[`color_${index}`] = 'Escribe el color.';
    } else if (colorName.length > 80) {
      errors[`color_${index}`] = 'El color no puede pasar de 80 caracteres.';
    } else {
      const colorKey = normalize(colorName);
      if (usedColorNames.has(colorKey)) {
        errors[`color_${index}`] = `El color ${colorName} está repetido.`;
      }
      usedColorNames.add(colorKey);
    }

    const tallas = sanitizeTallas(rawColor?.tallas, errors, index);
    const total = computeTotal(tallas);
    const procesos = sanitizeProcesos(rawColor?.procesos, total, index, errors, usedAssignmentIds);

    let colorId = String(rawColor?.id ?? '').trim();
    if (!colorId || usedColorIds.has(colorId)) colorId = uid();
    while (usedColorIds.has(colorId)) colorId = uid();
    usedColorIds.add(colorId);

    colores.push({
      id: colorId,
      color: colorName,
      tallas,
      procesos
    });
  });

  const ok = Object.keys(errors).length === 0;
  const now = new Date().toISOString();
  const existing = fichas.find((ficha) => ficha.id === currentId);

  return {
    ok,
    errors,
    ficha: ok
      ? {
          id: existing?.id || uid(),
          numero,
          fecha,
          modelo,
          colores,
          total: computeFichaTotal(colores),
          estado,
          notas,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        }
      : null
  };
}

export function migrateFicha(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const numero = String(raw.numero ?? '').trim();
  const fecha = String(raw.fecha ?? '').trim();
  const modelo = String(raw.modelo ?? '').trim();
  if (!numero || !modelo || !isValidISODate(fecha)) return null;

  let rawColores = Array.isArray(raw.colores) ? raw.colores : [];
  if (rawColores.length === 0 && Array.isArray(raw.tallas)) {
    rawColores = [{
      color: String(raw.color ?? '').trim() || 'Sin color',
      tallas: raw.tallas,
      procesos: {}
    }];
  }

  const colores = [];
  const usedColorIds = new Set();
  const usedAssignmentIds = new Set();
  const now = new Date().toISOString();

  for (const rawColor of rawColores.slice(0, MAX_COLORS)) {
    const colorName = String(rawColor?.color ?? '').trim().slice(0, 80) || 'Sin color';
    const tallas = [];
    const seenSizes = new Set();
    for (const row of Array.isArray(rawColor?.tallas) ? rawColor.tallas : []) {
      const talla = String(row?.talla ?? '').trim().slice(0, 20);
      const cantidad = Number(row?.cantidad);
      const key = normalize(talla);
      if (!talla || !key || seenSizes.has(key)) continue;
      if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > MAX_QUANTITY) continue;
      seenSizes.add(key);
      tallas.push({ talla, cantidad });
      if (tallas.length >= MAX_SIZES) break;
    }
    if (tallas.length === 0) continue;

    let colorId = String(rawColor?.id ?? '').trim();
    if (!colorId || usedColorIds.has(colorId)) colorId = uid();
    while (usedColorIds.has(colorId)) colorId = uid();
    usedColorIds.add(colorId);

    const procesos = createEmptyProcesos();
    const source = rawColor?.procesos && typeof rawColor.procesos === 'object' && !Array.isArray(rawColor.procesos)
      ? rawColor.procesos
      : {};
    for (const process of PROCESSES) {
      const rows = Array.isArray(source[process.id]) ? source[process.id] : [];
      for (const row of rows) {
        const trabajador = String(row?.trabajador ?? '').trim().slice(0, MAX_WORKER_LENGTH);
        const cantidad = Number(row?.cantidad);
        if (!trabajador || !Number.isInteger(cantidad) || cantidad <= 0 || cantidad > MAX_QUANTITY) continue;
        let id = String(row?.id ?? '').trim();
        if (!id || usedAssignmentIds.has(id)) id = uid();
        while (usedAssignmentIds.has(id)) id = uid();
        usedAssignmentIds.add(id);
        procesos[process.id].push({
          id,
          trabajador,
          cantidad,
          estado: ASSIGNMENT_STATUS_IDS.includes(row?.estado) ? row.estado : 'pendiente'
        });
      }
    }

    colores.push({ id: colorId, color: colorName, tallas, procesos });
  }

  if (colores.length === 0) return null;

  return {
    id: String(raw.id ?? '').trim() || uid(),
    numero,
    fecha,
    modelo,
    colores,
    total: computeFichaTotal(colores),
    estado: STATUS_IDS.includes(raw.estado) ? raw.estado : 'costura',
    notas: String(raw.notas ?? '').trim(),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  };
}

export function processProgress(color, processId) {
  const total = computeColorTotal(color);
  const rows = Array.isArray(color?.procesos?.[processId]) ? color.procesos[processId] : [];
  let assigned = 0;
  let finished = 0;
  let inProgress = 0;
  let pending = 0;

  for (const row of rows) {
    const quantity = Number(row?.cantidad);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    assigned += quantity;
    if (row.estado === 'terminado') finished += quantity;
    else if (row.estado === 'en_proceso') inProgress += quantity;
    else pending += quantity;
  }

  let estado = 'sin_asignar';
  if (rows.length > 0) {
    if (finished >= total && assigned >= total) estado = 'terminado';
    else if (finished > 0 || inProgress > 0) estado = 'en_proceso';
    else estado = 'pendiente';
  }

  return {
    total,
    assigned,
    finished,
    inProgress,
    pending,
    remaining: Math.max(0, total - finished),
    percent: total > 0 ? Math.min(100, Math.round((finished / total) * 100)) : 0,
    estado
  };
}

export function flattenAssignments(fichas) {
  const rows = [];
  for (const ficha of Array.isArray(fichas) ? fichas : []) {
    for (const color of Array.isArray(ficha?.colores) ? ficha.colores : []) {
      for (const process of PROCESSES) {
        const assignments = Array.isArray(color?.procesos?.[process.id]) ? color.procesos[process.id] : [];
        for (const assignment of assignments) {
          rows.push({
            id: assignment.id,
            fichaId: ficha.id,
            numero: ficha.numero,
            fecha: ficha.fecha,
            modelo: ficha.modelo,
            colorId: color.id,
            color: color.color,
            procesoId: process.id,
            proceso: process.label,
            trabajador: assignment.trabajador,
            cantidad: assignment.cantidad,
            estado: assignment.estado
          });
        }
      }
    }
  }
  return rows;
}

export function filterAssignments(assignments, filters = {}) {
  const from = filters.from ?? '';
  const to = filters.to ?? '';
  const worker = normalize(filters.worker ?? '');
  const process = filters.process ?? '';
  const status = filters.status ?? '';

  return (Array.isArray(assignments) ? assignments : [])
    .filter((row) => {
      if (from && (!row.fecha || row.fecha < from)) return false;
      if (to && (!row.fecha || row.fecha > to)) return false;
      if (worker && normalize(row.trabajador) !== worker) return false;
      if (process && row.procesoId !== process) return false;
      if (status && row.estado !== status) return false;
      return true;
    })
    .sort((a, b) => {
      const byDate = String(b.fecha ?? '').localeCompare(String(a.fecha ?? ''));
      if (byDate !== 0) return byDate;
      const byNumber = String(b.numero ?? '').localeCompare(String(a.numero ?? ''), 'es', { numeric: true });
      if (byNumber !== 0) return byNumber;
      const byColor = String(a.color ?? '').localeCompare(String(b.color ?? ''), 'es');
      if (byColor !== 0) return byColor;
      const byProcess = (PROCESS_ORDER.get(a.procesoId) ?? 99) - (PROCESS_ORDER.get(b.procesoId) ?? 99);
      if (byProcess !== 0) return byProcess;
      return String(a.trabajador ?? '').localeCompare(String(b.trabajador ?? ''), 'es');
    });
}

export function assignmentStats(assignments) {
  const rows = Array.isArray(assignments) ? assignments : [];
  const byStatus = {};
  for (const status of ASSIGNMENT_STATUSES) {
    byStatus[status.id] = { count: 0, cantidad: 0 };
  }

  const workers = new Map();
  const processes = new Map(PROCESSES.map((process) => [process.id, {
    id: process.id,
    label: process.label,
    count: 0,
    cantidad: 0,
    pendiente: 0,
    enProceso: 0,
    terminado: 0
  }]));

  const stats = {
    total: rows.length,
    cantidad: 0,
    pendiente: 0,
    enProceso: 0,
    terminado: 0,
    byStatus,
    trabajadores: [],
    procesos: []
  };

  for (const row of rows) {
    const quantity = Number(row?.cantidad);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    const status = ASSIGNMENT_STATUS_IDS.includes(row.estado) ? row.estado : 'pendiente';
    stats.cantidad += quantity;
    byStatus[status].count += 1;
    byStatus[status].cantidad += quantity;
    if (status === 'terminado') stats.terminado += quantity;
    else if (status === 'en_proceso') stats.enProceso += quantity;
    else stats.pendiente += quantity;

    const workerKey = normalize(row.trabajador);
    if (!workers.has(workerKey)) {
      workers.set(workerKey, {
        trabajador: row.trabajador,
        count: 0,
        cantidad: 0,
        pendiente: 0,
        enProceso: 0,
        terminado: 0
      });
    }
    const worker = workers.get(workerKey);
    worker.count += 1;
    worker.cantidad += quantity;
    if (status === 'terminado') worker.terminado += quantity;
    else if (status === 'en_proceso') worker.enProceso += quantity;
    else worker.pendiente += quantity;

    const process = processes.get(row.procesoId);
    if (process) {
      process.count += 1;
      process.cantidad += quantity;
      if (status === 'terminado') process.terminado += quantity;
      else if (status === 'en_proceso') process.enProceso += quantity;
      else process.pendiente += quantity;
    }
  }

  stats.trabajadores = Array.from(workers.values()).sort((a, b) => (
    b.cantidad - a.cantidad || a.trabajador.localeCompare(b.trabajador, 'es')
  ));
  stats.procesos = Array.from(processes.values());
  return stats;
}

export function filterFichas(fichas, filters = {}) {
  const query = normalize(filters.query ?? '');
  const status = filters.status ?? 'todas';
  const from = filters.from ?? '';
  const to = filters.to ?? '';

  return (Array.isArray(fichas) ? fichas : [])
    .filter((ficha) => {
      if (status !== 'todas' && ficha.estado !== status) return false;
      if (from && (!ficha.fecha || ficha.fecha < from)) return false;
      if (to && (!ficha.fecha || ficha.fecha > to)) return false;
      if (!query) return true;
      const colorRows = Array.isArray(ficha.colores) ? ficha.colores : [];
      const assignmentRows = flattenAssignments([ficha]);
      const searchable = normalize([
        ficha.numero,
        ficha.modelo,
        ficha.notas,
        statusLabel(ficha.estado),
        ...colorRows.flatMap((color) => [
          color.color,
          ...(Array.isArray(color.tallas) ? color.tallas.map((row) => row.talla) : [])
        ]),
        ...assignmentRows.flatMap((row) => [
          row.trabajador,
          row.proceso,
          assignmentStatusLabel(row.estado)
        ])
      ].join(' '));
      return searchable.includes(query);
    })
    .sort((a, b) => {
      const byDate = String(b.fecha ?? '').localeCompare(String(a.fecha ?? ''));
      if (byDate !== 0) return byDate;
      const byCreated = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
      if (byCreated !== 0) return byCreated;
      return String(b.numero ?? '').localeCompare(String(a.numero ?? ''), 'es', { numeric: true });
    });
}

export function countByStatus(fichas, query = '') {
  const base = filterFichas(fichas, { query });
  const counts = { todas: base.length };
  for (const status of STATUSES) {
    counts[status.id] = base.filter((ficha) => ficha.estado === status.id).length;
  }
  return counts;
}

export function computeStats(fichas) {
  const stats = {
    totalFichas: 0,
    totalPiezas: 0,
    totalAsignado: 0,
    totalTerminado: 0,
    byStatus: {}
  };

  for (const status of STATUSES) {
    stats.byStatus[status.id] = { id: status.id, label: status.label, count: 0, piezas: 0 };
  }

  const source = Array.isArray(fichas) ? fichas : [];
  for (const ficha of source) {
    const total = Number.isFinite(Number(ficha.total)) ? Number(ficha.total) : computeFichaTotal(ficha.colores);
    stats.totalFichas += 1;
    stats.totalPiezas += total;
    if (!stats.byStatus[ficha.estado]) {
      stats.byStatus[ficha.estado] = { id: ficha.estado, label: statusLabel(ficha.estado), count: 0, piezas: 0 };
    }
    stats.byStatus[ficha.estado].count += 1;
    stats.byStatus[ficha.estado].piezas += total;
  }

  for (const row of flattenAssignments(source)) {
    const quantity = Number(row.cantidad);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    stats.totalAsignado += quantity;
    if (row.estado === 'terminado') stats.totalTerminado += quantity;
  }

  return stats;
}

export function listWorkers(fichas, extra = []) {
  return sanitizeWorkers([
    ...flattenAssignments(fichas).map((row) => row.trabajador),
    ...extra
  ]).sort((a, b) => a.localeCompare(b, 'es'));
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function toCSV(fichas) {
  const header = ['Número', 'Fecha', 'Modelo', 'Colores y tallas', 'Total piezas', 'Estado', 'Notas'];
  const rows = (Array.isArray(fichas) ? fichas : []).map((ficha) => [
    ficha.numero,
    formatDate(ficha.fecha),
    ficha.modelo,
    coloresFull(ficha.colores),
    ficha.total,
    statusLabel(ficha.estado),
    ficha.notas
  ]);

  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export function assignmentsToCSV(assignments) {
  const header = ['Ficha', 'Fecha', 'Modelo', 'Color', 'Proceso', 'Trabajador', 'Cantidad', 'Estado'];
  const rows = (Array.isArray(assignments) ? assignments : []).map((row) => [
    row.numero,
    formatDate(row.fecha),
    row.modelo,
    row.color,
    row.proceso,
    row.trabajador,
    row.cantidad,
    assignmentStatusLabel(row.estado)
  ]);

  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export function fichaToText(ficha) {
  const processLines = [];
  for (const color of Array.isArray(ficha.colores) ? ficha.colores : []) {
    for (const process of PROCESSES) {
      const rows = Array.isArray(color?.procesos?.[process.id]) ? color.procesos[process.id] : [];
      if (rows.length === 0) continue;
      const detail = rows
        .map((row) => `${row.trabajador} ${row.cantidad} (${assignmentStatusLabel(row.estado)})`)
        .join(', ');
      processLines.push(`${color.color} · ${process.label}: ${detail}`);
    }
  }

  const colorLines = (Array.isArray(ficha.colores) ? ficha.colores : []).map((color) => (
    `${color.color} (${computeColorTotal(color)}): ${tallasFull(color.tallas)}`
  ));

  const lines = [
    `FICHA DE CORTE #${ficha.numero}`,
    `Modelo: ${ficha.modelo}`,
    `Fecha: ${formatDate(ficha.fecha)}`,
    `Total: ${ficha.total} piezas`,
    colorLines.length ? 'Colores:' : null,
    colorLines.join('\n'),
    `Estado: ${statusLabel(ficha.estado)}`,
    processLines.length ? 'Procesos:' : null,
    processLines.join('\n'),
    ficha.notas ? `Notas: ${ficha.notas}` : null
  ];
  return lines.filter(Boolean).join('\n');
}

export function validateBackup(data) {
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['El archivo no es un respaldo válido.'] };
  }
  if (!Array.isArray(data.fichas)) {
    return { ok: false, errors: ['El respaldo no contiene una lista de fichas.'] };
  }
  if (data.fichas.length > 20000) {
    return { ok: false, errors: ['El respaldo tiene demasiadas fichas.'] };
  }

  const usedIds = new Set();
  const usedNumbers = new Set();
  const fichas = [];

  data.fichas.forEach((raw, index) => {
    const label = `Ficha ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${label}: formato inválido.`);
      return;
    }

    const numero = String(raw.numero ?? '').trim();
    if (!numero) errors.push(`${label}: falta el número.`);
    if (!String(raw.modelo ?? '').trim()) errors.push(`${label}: falta el modelo.`);
    if (!isValidISODate(String(raw.fecha ?? ''))) errors.push(`${label}: la fecha no es válida.`);

    const numberKey = normalize(numero);
    if (numberKey && usedNumbers.has(numberKey)) {
      errors.push(`${label}: el número ${numero} está repetido.`);
    }
    if (numberKey) usedNumbers.add(numberKey);

    const input = {
      numero,
      fecha: String(raw.fecha ?? ''),
      modelo: String(raw.modelo ?? '').trim(),
      notas: String(raw.notas ?? '').trim(),
      estado: raw.estado,
      colores: Array.isArray(raw.colores) ? raw.colores : undefined
    };
    if (!Array.isArray(raw.colores) && Array.isArray(raw.tallas)) {
      input.colores = [{
        color: String(raw.color ?? '').trim() || 'Sin color',
        tallas: raw.tallas,
        procesos: raw.procesos ?? {}
      }];
    }

    const result = sanitizeFicha(input, { fichas });
    if (!result.ok) {
      const messages = Object.values(result.errors).slice(0, 4);
      for (const message of messages) errors.push(`${label}: ${message}`);
      return;
    }

    let id = String(raw.id ?? '').trim();
    if (!id || usedIds.has(id)) id = uid();
    while (usedIds.has(id)) id = uid();
    usedIds.add(id);

    const now = new Date().toISOString();
    fichas.push({
      ...result.ficha,
      id,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
    });
  });

  if (errors.length > 0) {
    return { ok: false, errors: errors.slice(0, 8) };
  }

  const assignmentWorkers = flattenAssignments(fichas).map((row) => row.trabajador);
  const trabajadores = sanitizeWorkers([
    ...(Array.isArray(data.trabajadores) ? data.trabajadores : []),
    ...(Array.isArray(data.settings?.trabajadores) ? data.settings.trabajadores : []),
    ...assignmentWorkers
  ]);

  return { ok: true, fichas, trabajadores };
}
