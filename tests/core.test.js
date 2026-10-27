import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentStats,
  assignmentsToCSV,
  coloresSummary,
  computeStats,
  countByStatus,
  fichaToText,
  filterAssignments,
  filterFichas,
  flattenAssignments,
  formatDate,
  listWorkers,
  migrateFicha,
  processProgress,
  sanitizeFicha,
  sanitizeWorkers,
  suggestNextNumero,
  toCSV,
  validateBackup
} from '../js/core.js';

function sampleColores() {
  return [
    {
      id: 'color-rojo',
      color: 'Rojo',
      tallas: [
        { talla: 'S', cantidad: 10 },
        { talla: 'M', cantidad: 5 }
      ],
      procesos: {
        recta: [
          { id: 'asig-1', trabajador: 'Ana', cantidad: 10, estado: 'terminado' },
          { id: 'asig-2', trabajador: 'Luis', cantidad: 5, estado: 'en_proceso' }
        ],
        over: [
          { id: 'asig-3', trabajador: 'Ana', cantidad: 15, estado: 'pendiente' }
        ]
      }
    },
    {
      id: 'color-azul',
      color: 'Azul',
      tallas: [
        { talla: 'M', cantidad: 4 }
      ],
      procesos: {}
    }
  ];
}

function buildFicha(overrides = {}, fichas = []) {
  const input = {
    numero: '101',
    fecha: '2026-10-20',
    modelo: 'Blusa básica',
    estado: 'costura',
    notas: '',
    colores: sampleColores(),
    ...overrides
  };
  const result = sanitizeFicha(input, { fichas });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.ficha;
}

test('sanitizeFicha calcula totales por color y normaliza colores y asignaciones', () => {
  const result = sanitizeFicha(
    {
      numero: '  12  ',
      fecha: '2026-10-27',
      modelo: '  Vestido  ',
      estado: 'costura',
      notas: '  Entregar el viernes  ',
      colores: [
        {
          id: 'c1',
          color: '  Azul  ',
          tallas: [
            { talla: ' S ', cantidad: '10' },
            { talla: 'M', cantidad: '5' }
          ],
          procesos: {
            recta: [
              { id: 'a1', trabajador: '  Ana  ', cantidad: '6', estado: 'terminado' }
            ]
          }
        },
        {
          id: 'c2',
          color: 'Negro',
          tallas: [{ talla: 'M', cantidad: '2' }],
          procesos: {}
        }
      ]
    },
    { fichas: [] }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ficha.numero, '12');
  assert.equal(result.ficha.modelo, 'Vestido');
  assert.equal(result.ficha.total, 17);
  assert.equal(result.ficha.colores.length, 2);
  assert.equal(result.ficha.colores[0].id, 'c1');
  assert.equal(result.ficha.colores[0].color, 'Azul');
  assert.equal(result.ficha.colores[0].procesos.recta[0].trabajador, 'Ana');
  assert.equal(result.ficha.colores[0].procesos.recta[0].cantidad, 6);
  assert.equal(result.ficha.colores[1].id, 'c2');
  assert.equal(result.ficha.notas, 'Entregar el viernes');
});

test('sanitizeFicha exige número, fecha, modelo, color y tallas', () => {
  const result = sanitizeFicha(
    {
      numero: '',
      fecha: '',
      modelo: '',
      colores: [{ color: '', tallas: [{ talla: '', cantidad: '' }] }]
    },
    { fichas: [] }
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.numero);
  assert.ok(result.errors.fecha);
  assert.ok(result.errors.modelo);
  assert.ok(result.errors.color_0);
  assert.ok(result.errors.tallas_0);

  const noColors = sanitizeFicha(
    { numero: '1', fecha: '2026-10-20', modelo: 'Blusa', colores: [] },
    { fichas: [] }
  );
  assert.equal(noColors.ok, false);
  assert.ok(noColors.errors.colores);
});

test('sanitizeFicha rechaza números de ficha repetidos sin distinguir mayúsculas', () => {
  const existing = buildFicha({ numero: 'F-01' });
  const result = sanitizeFicha(
    {
      numero: 'f-01',
      fecha: '2026-10-20',
      modelo: 'Otra blusa',
      colores: [{ color: 'Rojo', tallas: [{ talla: 'S', cantidad: 1 }] }]
    },
    { fichas: [existing] }
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.numero, /Ya existe/);
});

test('sanitizeFicha conserva ids, fechas y asignaciones al editar', () => {
  const existing = buildFicha({ numero: 'F-01' });
  const result = sanitizeFicha(
    {
      numero: 'F-01',
      fecha: '2026-10-20',
      modelo: 'Blusa corregida',
      estado: existing.estado,
      colores: existing.colores
    },
    { fichas: [existing], currentId: existing.id }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ficha.id, existing.id);
  assert.equal(result.ficha.createdAt, existing.createdAt);
  assert.equal(result.ficha.colores[0].id, 'color-rojo');
  assert.equal(result.ficha.colores[0].procesos.recta.length, 2);
});

test('sanitizeFicha detecta colores repetidos y tallas repetidas dentro de cada color', () => {
  const duplicateColors = sanitizeFicha(
    {
      numero: '20',
      fecha: '2026-10-20',
      modelo: 'Blusa',
      colores: [
        { color: 'Rojo', tallas: [{ talla: 'S', cantidad: 1 }] },
        { color: 'rojo', tallas: [{ talla: 'M', cantidad: 2 }] }
      ]
    },
    { fichas: [] }
  );
  assert.equal(duplicateColors.ok, false);
  assert.match(duplicateColors.errors.color_1, /repetido/);

  const duplicateSizes = sanitizeFicha(
    {
      numero: '21',
      fecha: '2026-10-20',
      modelo: 'Blusa',
      colores: [
        { color: 'Rojo', tallas: [{ talla: 'S', cantidad: 1 }, { talla: 's', cantidad: 2 }] },
        { color: 'Azul', tallas: [{ talla: 'S', cantidad: 3 }] }
      ]
    },
    { fichas: [] }
  );
  assert.equal(duplicateSizes.ok, false);
  assert.match(duplicateSizes.errors.talla_0_1, /repetida/);
  assert.equal(duplicateSizes.errors.talla_1_0, undefined);
});

test('sanitizeFicha omite filas vacías y cantidades en cero', () => {
  const result = sanitizeFicha(
    {
      numero: '30',
      fecha: '2026-10-20',
      modelo: 'Pantalón',
      colores: [
        {
          color: 'Negro',
          tallas: [
            { talla: '', cantidad: '' },
            { talla: 'S', cantidad: 0 },
            { talla: 'M', cantidad: 8 }
          ]
        }
      ]
    },
    { fichas: [] }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ficha.colores[0].tallas, [{ talla: 'M', cantidad: 8 }]);
  assert.equal(result.ficha.total, 8);
});

test('sanitizeFicha valida responsables y evita asignar más piezas que el total del color', () => {
  const overAssigned = sanitizeFicha(
    {
      numero: '31',
      fecha: '2026-10-20',
      modelo: 'Blusa',
      colores: [{
        color: 'Rojo',
        tallas: [{ talla: 'M', cantidad: 10 }],
        procesos: {
          recta: [
            { trabajador: 'Ana', cantidad: 6, estado: 'pendiente' },
            { trabajador: 'Luis', cantidad: 6, estado: 'pendiente' }
          ]
        }
      }]
    },
    { fichas: [] }
  );
  assert.equal(overAssigned.ok, false);
  assert.match(overAssigned.errors.proceso_0_recta, /supera/);

  const missingWorker = sanitizeFicha(
    {
      numero: '32',
      fecha: '2026-10-20',
      modelo: 'Blusa',
      colores: [{
        color: 'Rojo',
        tallas: [{ talla: 'M', cantidad: 10 }],
        procesos: { recta: [{ trabajador: '', cantidad: 2, estado: 'pendiente' }] }
      }]
    },
    { fichas: [] }
  );
  assert.equal(missingWorker.ok, false);
  assert.match(missingWorker.errors.asignacion_0_recta_0, /trabajador/);

  const badQuantity = sanitizeFicha(
    {
      numero: '33',
      fecha: '2026-10-20',
      modelo: 'Blusa',
      colores: [{
        color: 'Rojo',
        tallas: [{ talla: 'M', cantidad: 10 }],
        procesos: { recta: [{ trabajador: 'Ana', cantidad: '1.5', estado: 'pendiente' }] }
      }]
    },
    { fichas: [] }
  );
  assert.equal(badQuantity.ok, false);
  assert.match(badQuantity.errors.asignacion_0_recta_0, /entero/);
});

test('suggestNextNumero toma el mayor número numérico', () => {
  assert.equal(suggestNextNumero([]), '1');
  assert.equal(
    suggestNextNumero([{ numero: '1' }, { numero: '9' }, { numero: 'F-20' }, { numero: '3' }]),
    '10'
  );
});

test('formatDate presenta la fecha en formato costarricense', () => {
  assert.equal(formatDate('2026-10-27'), '27/10/2026');
  assert.equal(formatDate(''), 'Sin fecha');
});

test('filterFichas busca por color, talla y trabajador, y filtra por estado y fecha', () => {
  const fichas = [
    buildFicha({ numero: '1', fecha: '2026-10-01', modelo: 'Blusa básica', estado: 'costura' }),
    buildFicha({
      numero: '2',
      fecha: '2026-10-15',
      modelo: 'Pantalón',
      estado: 'costura',
      colores: [{ color: 'Verde', tallas: [{ talla: 'L', cantidad: 3 }], procesos: {} }]
    }),
    buildFicha({
      numero: '3',
      fecha: '2026-11-02',
      modelo: 'Vestido',
      estado: 'terminado',
      colores: [{ color: 'Blanco', tallas: [{ talla: 'XS', cantidad: 2 }], procesos: {} }]
    })
  ];

  assert.equal(filterFichas(fichas, { query: 'basica' }).length, 1);
  assert.equal(filterFichas(fichas, { query: 'rojo' }).length, 1);
  assert.equal(filterFichas(fichas, { query: 'luis' }).length, 1);
  assert.equal(filterFichas(fichas, { query: 'l' }).length, 3);
  assert.equal(filterFichas(fichas, { status: 'costura' }).length, 2);
  assert.equal(filterFichas(fichas, { from: '2026-10-10', to: '2026-10-31' }).length, 1);
  assert.equal(filterFichas(fichas, { query: 'vestido', status: 'costura' }).length, 0);
  assert.equal(filterFichas(fichas, {}).length, 3);
});

test('countByStatus cuenta todas y cada estado respetando la búsqueda', () => {
  const fichas = [
    buildFicha({ numero: '1', modelo: 'Blusa', estado: 'costura' }),
    buildFicha({ numero: '2', modelo: 'Pantalón', estado: 'costura' }),
    buildFicha({ numero: '3', modelo: 'Blusa sport', estado: 'terminado' })
  ];

  assert.deepEqual(countByStatus(fichas, ''), {
    todas: 3,
    costura: 2,
    terminado: 1
  });
  assert.deepEqual(countByStatus(fichas, 'blusa'), {
    todas: 2,
    costura: 1,
    terminado: 1
  });
});

test('computeStats suma fichas, piezas y avance de asignaciones', () => {
  const fichas = [
    buildFicha({ numero: '1', estado: 'terminado' }),
    buildFicha({
      numero: '2',
      estado: 'costura',
      colores: [{ color: 'M', tallas: [{ talla: 'M', cantidad: 5 }], procesos: {} }]
    }),
    buildFicha({
      numero: '3',
      estado: 'costura',
      colores: [{
        color: 'L',
        tallas: [{ talla: 'L', cantidad: 3 }],
        procesos: {
          recta: [{ trabajador: 'Eva', cantidad: 3, estado: 'terminado' }]
        }
      }]
    })
  ];
  const stats = computeStats(fichas);

  assert.equal(stats.totalFichas, 3);
  assert.equal(stats.totalPiezas, 27);
  assert.equal(stats.totalAsignado, 33);
  assert.equal(stats.totalTerminado, 13);
  assert.equal(stats.byStatus.costura.count, 2);
  assert.equal(stats.byStatus.costura.piezas, 8);
  assert.equal(stats.byStatus.terminado.count, 1);
  assert.equal(stats.byStatus.terminado.piezas, 19);
});

test('processProgress calcula cantidades asignadas y terminadas', () => {
  const color = sampleColores()[0];
  const progress = processProgress(color, 'recta');

  assert.equal(progress.total, 15);
  assert.equal(progress.assigned, 15);
  assert.equal(progress.finished, 10);
  assert.equal(progress.inProgress, 5);
  assert.equal(progress.remaining, 5);
  assert.equal(progress.percent, 67);
  assert.equal(progress.estado, 'en_proceso');

  const empty = processProgress(sampleColores()[1], 'over');
  assert.equal(empty.estado, 'sin_asignar');
  assert.equal(empty.assigned, 0);
});

test('flattenAssignments y filterAssignments conservan ficha, color y proceso', () => {
  const ficha = buildFicha({ numero: '77' });
  const rows = flattenAssignments([ficha]);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].numero, '77');
  assert.equal(rows[0].color, 'Rojo');
  assert.equal(rows[0].proceso, 'Recta');
  assert.equal(rows[0].fecha, '2026-10-20');

  assert.equal(filterAssignments(rows, { worker: 'ana' }).length, 2);
  assert.equal(filterAssignments(rows, { process: 'over' }).length, 1);
  assert.equal(filterAssignments(rows, { status: 'en_proceso' }).length, 1);
  assert.equal(filterAssignments(rows, { from: '2026-10-21' }).length, 0);
});

test('assignmentStats agrupa por trabajador y por proceso', () => {
  const rows = flattenAssignments([buildFicha()]);
  const stats = assignmentStats(rows);

  assert.equal(stats.total, 3);
  assert.equal(stats.cantidad, 30);
  assert.equal(stats.terminado, 10);
  assert.equal(stats.enProceso, 5);
  assert.equal(stats.pendiente, 15);
  assert.equal(stats.trabajadores.length, 2);
  assert.equal(stats.trabajadores[0].trabajador, 'Ana');
  assert.equal(stats.trabajadores[0].cantidad, 25);
  assert.equal(stats.trabajadores[0].terminado, 10);
  assert.equal(stats.procesos.find((row) => row.id === 'recta').cantidad, 15);
  assert.equal(stats.procesos.find((row) => row.id === 'over').pendiente, 15);
});

test('toCSV genera un archivo compatible con Excel y escapa comillas', () => {
  const ficha = buildFicha({
    numero: '7',
    fecha: '2026-10-27',
    modelo: 'Camisa "clásica"',
    notas: 'Línea 1\nLínea 2',
    colores: [
      {
        color: 'Blanco',
        tallas: [{ talla: 'S', cantidad: 2 }, { talla: 'M', cantidad: 3 }],
        procesos: {}
      }
    ]
  });
  const csv = toCSV([ficha]);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /"Número";"Fecha";"Modelo";"Colores y tallas";"Total piezas";"Estado";"Notas"/);
  assert.match(csv, /"Camisa ""clásica"""/);
  assert.match(csv, /"Blanco: S: 2 \| M: 3"/);
  assert.match(csv, /"5"/);
  assert.match(csv, /"27\/10\/2026"/);
});

test('assignmentsToCSV exporta el detalle de asignaciones', () => {
  const rows = flattenAssignments([buildFicha({ numero: '8' })]);
  const csv = assignmentsToCSV(rows);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /"Ficha";"Fecha";"Modelo";"Color";"Proceso";"Trabajador";"Cantidad";"Estado"/);
  assert.match(csv, /"8";"20\/10\/2026";"Blusa básica";"Rojo";"Recta";"Ana";"10";"Terminado"/);
  assert.match(csv, /"Luis";"5";"En proceso"/);
});

test('fichaToText arma el texto con colores y procesos', () => {
  const ficha = buildFicha({ numero: '55', modelo: 'Short', notas: 'Pagar al entregar' });
  const text = fichaToText(ficha);

  assert.match(text, /FICHA DE CORTE #55/);
  assert.match(text, /Modelo: Short/);
  assert.match(text, /Total: 19 piezas/);
  assert.match(text, /Rojo \(15\): S: 10 \| M: 5/);
  assert.match(text, /Azul \(4\): M: 4/);
  assert.match(text, /Rojo · Recta: Ana 10 \(Terminado\), Luis 5 \(En proceso\)/);
  assert.match(text, /Notas: Pagar al entregar/);
});

test('migrateFicha convierte fichas v1 de un color al modelo de colores', () => {
  const ficha = migrateFicha({
    id: 'f-1',
    numero: '1',
    fecha: '2026-10-20',
    modelo: 'Blusa',
    color: 'Rojo',
    tallas: [{ talla: 'S', cantidad: 10 }],
    estado: 'costura',
    notas: 'Hola'
  });

  assert.equal(ficha.id, 'f-1');
  assert.equal(ficha.colores.length, 1);
  assert.equal(ficha.colores[0].color, 'Rojo');
  assert.equal(ficha.colores[0].tallas[0].cantidad, 10);
  assert.equal(ficha.colores[0].procesos.recta.length, 0);
  assert.equal(ficha.total, 10);
  assert.equal(ficha.estado, 'costura');

  const noColor = migrateFicha({
    numero: '2',
    fecha: '2026-10-20',
    modelo: 'Blusa',
    tallas: [{ talla: 'M', cantidad: 1 }]
  });
  assert.equal(noColor.colores[0].color, 'Sin color');
});

test('migrateFicha conserva el modelo v2 y normaliza datos inválidos', () => {
  const ficha = migrateFicha({
    numero: '9',
    fecha: '2026-10-20',
    modelo: 'Polo',
    colores: [{
      id: 'c1',
      color: 'Negro',
      tallas: [{ talla: 'M', cantidad: 5 }],
      procesos: {
        recta: [
          { id: 'a1', trabajador: 'Ana', cantidad: 5, estado: 'terminado' },
          { trabajador: '', cantidad: 5, estado: 'terminado' }
        ]
      }
    }]
  });

  assert.equal(ficha.colores[0].id, 'c1');
  assert.equal(ficha.colores[0].procesos.recta.length, 1);
  assert.equal(ficha.colores[0].procesos.recta[0].trabajador, 'Ana');
  assert.equal(ficha.total, 5);
  assert.equal(ficha.estado, 'costura');
});

test('migrateFicha convierte el estado antiguo cortado a costura', () => {
  const ficha = migrateFicha({
    numero: '10',
    fecha: '2026-10-20',
    modelo: 'Polo',
    estado: 'cortado',
    colores: [{
      color: 'Azul',
      tallas: [{ talla: 'M', cantidad: 4 }],
      procesos: {}
    }]
  });

  assert.equal(ficha.estado, 'costura');
});

test('validateBackup acepta respaldos v2 y corrige ids repetidos', () => {
  const first = buildFicha({ numero: '1' });
  const second = buildFicha({ numero: '2' });
  second.id = first.id;

  const result = validateBackup({ version: 2, fichas: [first, second], trabajadores: ['Ana', ' ana ', 'Luis'] });

  assert.equal(result.ok, true);
  assert.equal(result.fichas.length, 2);
  assert.notEqual(result.fichas[0].id, result.fichas[1].id);
  assert.equal(result.fichas[0].total, 19);
  assert.deepEqual(result.trabajadores, ['Ana', 'Luis']);
});

test('validateBackup migra respaldos v1 y rechaza datos incompletos', () => {
  const legacy = validateBackup({
    version: 1,
    fichas: [{
      numero: '1',
      fecha: '2026-10-20',
      modelo: 'Blusa',
      color: 'Rojo',
      tallas: [{ talla: 'S', cantidad: 3 }]
    }]
  });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.fichas[0].colores[0].color, 'Rojo');
  assert.equal(legacy.fichas[0].total, 3);

  const first = buildFicha({ numero: '1' });
  const duplicate = { ...buildFicha({ numero: '2' }), numero: '1' };
  const repeated = validateBackup({ fichas: [first, duplicate] });
  assert.equal(repeated.ok, false);
  assert.ok(repeated.errors.some((error) => /repetido/.test(error)));

  const incomplete = validateBackup({
    fichas: [{ numero: '9', fecha: '2026-10-20', modelo: '', colores: [] }]
  });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.errors.length >= 2);
});

test('sanitizeWorkers y listWorkers quitan duplicados sin distinguir mayúsculas', () => {
  assert.deepEqual(sanitizeWorkers([' Ana ', 'ana', '', 'Luis', 'LUIS']), ['Ana', 'Luis']);

  const workers = listWorkers([buildFicha()], ['Eva', 'ana']);
  assert.deepEqual(workers, ['Ana', 'Eva', 'Luis']);
});

test('coloresSummary resume varios colores para las tarjetas', () => {
  const summary = coloresSummary(sampleColores(), 1, 1);
  assert.match(summary, /Rojo: S: 10/);
  assert.match(summary, /\+1 color/);
});
