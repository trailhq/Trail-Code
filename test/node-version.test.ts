import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeSupported, nodeTooOld } from '../src/node-version.js';

test('nodeSupported: 22.3 and up, and 20.16 and up on 20, where process.getBuiltinModule exists', () => {
  for (const v of ['20.16.0', '20.19.1', '22.3.0', '22.12.0', '23.0.0', '24.11.1', '26.0.0']) assert.equal(nodeSupported(v), true, v);
  for (const v of ['16.20.2', '18.20.8', '20.15.1', '21.7.3', '22.2.0']) assert.equal(nodeSupported(v), false, v);
  assert.equal(nodeSupported(), true, 'the Node running these tests');
});

test('nodeTooOld: one plain message naming this Node and the reinstall, or nothing', () => {
  assert.equal(nodeTooOld('trail', '@trailhq/trail-code', '24.0.0'), null);
  assert.equal(
    nodeTooOld('trail', '@trailhq/trail-code', '18.20.8'),
    '✗ trail needs Node 22.3 or newer (20.16 works too); this is Node 18.20.8.\n' +
      '  Update Node (https://nodejs.org, or `nvm install 22` if you use nvm), then run `npm i -g @trailhq/trail-code` again.',
  );
});
