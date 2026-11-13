import assert from 'node:assert/strict';
import test from 'node:test';
import { Daybook, DaybookError, AlbaCortex, Bitacora, BitacoraError, VimoCortex, VimoContex } from '../dist/index.js';

test('Daybook exports keep the same runtime and legacy import compatibility', () => {
  assert.equal(Daybook, Bitacora);
  assert.equal(DaybookError, BitacoraError);
  assert.equal(AlbaCortex, Daybook);
  assert.equal(VimoCortex, Daybook);
  assert.equal(VimoContex, Daybook);
});
