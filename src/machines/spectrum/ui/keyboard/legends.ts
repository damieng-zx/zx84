/**
 * Locale-keyed keyboard legend data for the Spectrum on-screen keyboard.
 *
 * The physical keyboard matrix is identical for every Spectrum model; only
 * the ROM changes, which maps different glyphs to the same matrix positions.
 * This module provides the visual keycap legends for UK, Spanish ('es'),
 * and French ('fr') locales so the keyboard pane can adapt.
 */

import type { MachineLocale } from '@/machines/machine.ts';
import type { LetterLegend, NumberLegend } from './keyboard-common.tsx';

// ── UK legends (current, unchanged) ────────────────────────────────────────

const UK_LETTERS: Record<string, LetterLegend> = {
  Q: { green: 'SIN', ess: 'ASN', red: '<=', word: 'PLOT' },
  W: { green: 'COS', ess: 'ACS', red: '<>', word: 'DRAW' },
  E: { green: 'TAN', ess: 'ATN', red: '>=', word: 'REM' },
  R: { green: 'INT', ess: 'VERIFY', red: '<', word: 'RUN' },
  T: { green: 'RND', ess: 'MERGE', red: '>', word: 'RAND' },
  Y: { green: 'STR $', ess: '[', red: 'AND', word: 'RETURN' },
  U: { green: 'CHR $', ess: ']', red: 'OR', word: 'IF' },
  I: { green: 'CODE', ess: 'IN', red: 'AT', word: 'INPUT' },
  O: { green: 'PEEK', ess: 'OUT', red: ';', word: 'POKE' },
  P: { green: 'TAB', ess: '\u00A9', red: '"', word: 'PRINT' },
  A: { green: 'READ', ess: '~', red: 'STOP', word: 'NEW' },
  S: { green: 'RESTORE', ess: '|', red: 'NOT', word: 'SAVE' },
  D: { green: 'DATA', ess: '\\', red: 'STEP', word: 'DIM' },
  F: { green: 'SGN', ess: '{', red: 'TO', word: 'FOR' },
  G: { green: 'ABS', ess: '}', red: 'THEN', word: 'GOTO' },
  H: { green: 'SQR', ess: 'CIRCLE', red: '\u2191', word: 'GOSUB' },
  J: { green: 'VAL', ess: 'VAL $', red: '\u2212', word: 'LOAD' },
  K: { green: 'LEN', ess: 'SCREEN $', red: '+', word: 'LIST' },
  L: { green: 'USR', ess: 'ATTR', red: '=', word: 'LET' },
  Z: { green: 'LN', ess: 'BEEP', red: ':', word: 'COPY' },
  X: { green: 'EXP', ess: 'INK', red: '\u00A3', word: 'CLEAR' },
  C: { green: 'L PRINT', ess: 'PAPER', red: '?', word: 'CONT' },
  V: { green: 'L LIST', ess: 'FLASH', red: '/', word: 'CLS' },
  B: { green: 'BIN', ess: 'BRIGHT', red: '*', word: 'BORDER' },
  N: { green: 'INKEY $', ess: 'OVER', red: ',', word: 'NEXT' },
  M: { green: 'PI', ess: 'INVERSE', red: '.', word: 'PAUSE' },
};

const UK_NUMBERS: Record<string, NumberLegend> = {
  '1': { color: 'BLUE',    colorCss: '#2f7bff', cmd: 'EDIT',       ext: 'DEF FN',  red: '!', block: 1 },
  '2': { color: 'RED',     colorCss: '#ff3b3b', cmd: 'CAPS LOCK',  ext: 'FN',      red: '@', block: 2 },
  '3': { color: 'MAGENTA', colorCss: '#d24bd2', cmd: 'TRUE VIDEO', ext: 'LINE',    red: '#', block: 3 },
  '4': { color: 'GREEN',   colorCss: '#33cc55', cmd: 'INV. VIDEO', ext: 'OPEN #',  red: '$', block: 4 },
  '5': { color: 'CYAN',    colorCss: '#2ad2d2', cmd: '\u2190',     ext: 'CLOSE #', red: '%', block: 5 },
  '6': { color: 'YELLOW',  colorCss: '#e6d62e', cmd: '\u2193',     ext: 'MOVE',    red: '&', block: 6 },
  '7': { color: 'WHITE',   colorCss: '#ffffff', cmd: '\u2191',     ext: 'ERASE',   red: "'", block: 7 },
  '8': {                                         cmd: '\u2192',     ext: 'POINT',   red: '(', block: 8 },
  '9': {                                         cmd: 'GRAPHICS',   ext: 'CAT',     red: ')' },
  '0': { color: 'BLACK',   colorCss: '#000',    cmd: 'DELETE',     ext: 'FORMAT',  red: '_' },
};

// ── Spanish (Investrónica) legends ─────────────────────────────────────────

const ES_LETTERS: Record<string, LetterLegend> = {
  Q: { green: 'SEN', ess: 'ASN', red: '<=',  word: 'PLOT' },
  W: { green: 'COS', ess: 'ACS', red: '<>',  word: 'DIBUJ' },
  E: { green: 'TAN', ess: 'ATN', red: '>=',  word: 'REM' },
  R: { green: 'INT', ess: 'VER', red: '<',   word: 'EJEC' },
  T: { green: 'RND', ess: 'COMB', red: '>',  word: 'ALEAT' },
  Y: { green: 'CAD $', ess: '[', red: 'Y', word: 'VOLVER' },
  U: { green: 'CAR $', ess: ']', red: 'O',  word: 'SI' },
  I: { green: 'COD', ess: 'ENT', red: 'EN', word: 'ENTRA' },
  O: { green: 'PEEK', ess: 'SAL', red: ';', word: 'ALTER' },
  P: { green: 'TAB', ess: '\u00A9', red: '"', word: 'IMPR' },
  A: { green: 'LEER', ess: '~', red: 'PARAR', word: 'NUEVO' },
  S: { green: 'REST', ess: '|', red: 'NO',  word: 'GRABAR' },
  D: { green: 'DATOS', ess: '\\', red: 'PASO', word: 'DIM' },
  F: { green: 'SGN', ess: '{', red: 'A',   word: 'PARA' },
  G: { green: 'ABS', ess: '}', red: 'ENTON', word: 'IR A' },
  H: { green: 'RAIZ', ess: 'CIRC', red: '\u2191', word: 'IRSU' },
  J: { green: 'VAL', ess: 'VAL $', red: '\u2212', word: 'CARGA' },
  K: { green: 'LONG', ess: 'PANT $', red: '+', word: 'LIST' },
  L: { green: 'USR', ess: 'ATRI', red: '=', word: 'ASIG' },
  Z: { green: 'LN', ess: 'PITI', red: ':', word: 'COPIAR' },
  X: { green: 'EXP', ess: 'TINTA', red: '\u00D1', word: 'BORRA' },
  C: { green: 'L PRN', ess: 'PAPEL', red: '?', word: 'CONT' },
  V: { green: 'L LST', ess: 'DEST', red: '/', word: 'PANT' },
  B: { green: 'BIN', ess: 'BRILL', red: '*', word: 'BORDE' },
  N: { green: 'TECLA $', ess: 'INV', red: ',', word: 'SIG' },
  M: { green: 'PI', ess: 'INVERS', red: '.', word: 'PAUSA' },
};

const ES_NUMBERS: Record<string, NumberLegend> = {
  '1': { color: 'AZUL',    colorCss: '#2f7bff', cmd: 'EDIT',       ext: 'DEF FN',  red: '!', block: 1 },
  '2': { color: 'ROJO',    colorCss: '#ff3b3b', cmd: 'MAY\u00DAS', ext: 'FN',      red: '@', block: 2 },
  '3': { color: 'MAGENTA', colorCss: '#d24bd2', cmd: 'V. NORMAL',  ext: 'LINEA',   red: '#', block: 3 },
  '4': { color: 'VERDE',   colorCss: '#33cc55', cmd: 'V. INV',     ext: 'ABRIR #', red: '$', block: 4 },
  '5': { color: 'CYAN',    colorCss: '#2ad2d2', cmd: '\u2190',     ext: 'CERR #',  red: '%', block: 5 },
  '6': { color: 'AMARILLO',colorCss: '#e6d62e', cmd: '\u2193',     ext: 'MOVER',   red: '&', block: 6 },
  '7': { color: 'BLANCO',  colorCss: '#ffffff', cmd: '\u2191',     ext: 'BORRAR',  red: "'", block: 7 },
  '8': {                                         cmd: '\u2192',     ext: 'PUNTO',   red: '(', block: 8 },
  '9': {                                         cmd: 'GRAFICO',    ext: 'CATAL',    red: ')' },
  '0': { color: 'NEGRO',   colorCss: '#000',    cmd: 'SUPRIMIR',   ext: 'FORMAT',  red: '_' },
};

// ── French legends ──────────────────────────────────────────────────────────

const FR_LETTERS: Record<string, LetterLegend> = {
  Q: { green: 'SIN', ess: 'ASN', red: '<=',  word: 'PLOT' },
  W: { green: 'COS', ess: 'ACS', red: '<>',  word: 'DRAW' },
  E: { green: 'TAN', ess: 'ATN', red: '>=',  word: 'REM' },
  R: { green: 'INT', ess: 'VERIFY', red: '<', word: 'RUN' },
  T: { green: 'RND', ess: 'MERGE', red: '>',  word: 'RAND' },
  Y: { green: 'STR $', ess: '[', red: 'AND', word: 'RETURN' },
  U: { green: 'CHR $', ess: ']', red: 'OR',  word: 'IF' },
  I: { green: 'CODE', ess: 'IN', red: 'AT',  word: 'INPUT' },
  O: { green: 'PEEK', ess: 'OUT', red: ';',  word: 'POKE' },
  P: { green: 'TAB', ess: '\u00A9', red: '"', word: 'PRINT' },
  A: { green: 'READ', ess: '~', red: 'STOP',  word: 'NEW' },
  S: { green: 'RESTORE', ess: '|', red: 'NOT', word: 'SAVE' },
  D: { green: 'DATA', ess: '\\', red: 'STEP', word: 'DIM' },
  F: { green: 'SGN', ess: '{', red: 'TO',    word: 'FOR' },
  G: { green: 'ABS', ess: '}', red: 'THEN',  word: 'GOTO' },
  H: { green: 'SQR', ess: 'CIRCLE', red: '\u2191', word: 'GOSUB' },
  J: { green: 'VAL', ess: 'VAL $', red: '\u2212', word: 'LOAD' },
  K: { green: 'LEN', ess: 'SCREEN $', red: '+', word: 'LIST' },
  L: { green: 'USR', ess: 'ATTR', red: '=',  word: 'LET' },
  Z: { green: 'LN', ess: 'BEEP', red: ':',   word: 'COPY' },
  X: { green: 'EXP', ess: 'INK', red: '\u00A3', word: 'CLEAR' },
  C: { green: 'L PRINT', ess: 'PAPER', red: '?', word: 'CONT' },
  V: { green: 'L LIST', ess: 'FLASH', red: '/', word: 'CLS' },
  B: { green: 'BIN', ess: 'BRIGHT', red: '*', word: 'BORDER' },
  N: { green: 'INKEY $', ess: 'OVER', red: ',', word: 'NEXT' },
  M: { green: 'PI', ess: 'INVERSE', red: '.', word: 'PAUSE' },
};

const FR_NUMBERS: Record<string, NumberLegend> = {
  '1': { color: 'BLEU',    colorCss: '#2f7bff', cmd: 'EDIT',       ext: 'DEF FN',  red: '!', block: 1 },
  '2': { color: 'ROUGE',   colorCss: '#ff3b3b', cmd: 'VERR MAJ',   ext: 'FN',      red: '@', block: 2 },
  '3': { color: 'MAGENTA', colorCss: '#d24bd2', cmd: 'VIDEO NORM', ext: 'LIGNE',   red: '#', block: 3 },
  '4': { color: 'VERT',    colorCss: '#33cc55', cmd: 'VIDEO INV',  ext: 'OUVRIR #', red: '$', block: 4 },
  '5': { color: 'CYAN',    colorCss: '#2ad2d2', cmd: '\u2190',     ext: 'FERMER #', red: '%', block: 5 },
  '6': { color: 'JAUNE',   colorCss: '#e6d62e', cmd: '\u2193',     ext: 'DEPLAC',  red: '&', block: 6 },
  '7': { color: 'BLANC',   colorCss: '#ffffff', cmd: '\u2191',     ext: 'EFFACER', red: "'", block: 7 },
  '8': {                                         cmd: '\u2192',     ext: 'POINT',   red: '(', block: 8 },
  '9': {                                         cmd: 'GRAPHIQUE',  ext: 'CATAL',   red: ')' },
  '0': { color: 'NOIR',    colorCss: '#000',    cmd: 'SUPPRIMER',  ext: 'FORMAT',  red: '_' },
};

// ── Locale-keyed lookups ────────────────────────────────────────────────────

export const LOCALE_LETTERS: Record<MachineLocale, Record<string, LetterLegend>> = {
  uk: UK_LETTERS,
  es: ES_LETTERS,
  fr: FR_LETTERS,
};

export const LOCALE_NUMBERS: Record<MachineLocale, Record<string, NumberLegend>> = {
  uk: UK_NUMBERS,
  es: ES_NUMBERS,
  fr: FR_NUMBERS,
};

export function lettersFor(locale: MachineLocale): Record<string, LetterLegend> {
  return LOCALE_LETTERS[locale] ?? UK_LETTERS;
}

export function numbersFor(locale: MachineLocale): Record<string, NumberLegend> {
  return LOCALE_NUMBERS[locale] ?? UK_NUMBERS;
}
