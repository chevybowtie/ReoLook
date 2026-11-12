import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDemoCameras, DEMO_USER, DEMO_ADMIN, DEMO_PASSWORD } from '../src/demo.mjs';
import { ReolinkClient, streamOverrides } from '../src/client.mjs';

test('a simulated camera answers like a real one, and only an admin can change it', async () => {
  const sim = await startDemoCameras();
  try {
    const { host } = sim.cameras[0];
    const viewer = new ReolinkClient({ host, user: DEMO_USER, password: DEMO_PASSWORD });
    const info = await viewer.command('GetDevInfo');
    assert.equal(info.DevInfo.name, 'Front door');
    await assert.rejects(() => viewer.command('SetDevName', { DevName: { name: 'x' } }));
    const admin = new ReolinkClient({ host, user: DEMO_ADMIN, password: DEMO_PASSWORD });
    await admin.command('SetDevName', { DevName: { name: 'Porch' } });
    assert.equal((await admin.command('GetDevName')).DevName.name, 'Porch');
    await assert.rejects(() => new ReolinkClient({ host, user: DEMO_USER, password: 'wrong' }).command('GetDevInfo'));
    assert.match(new ReolinkClient({ host, user: DEMO_USER, password: DEMO_PASSWORD }).rtspUrl({ channel: 0, stream: 'sub' }), /^lavfi:/);
  } finally {
    await sim.stop();
  }
  assert.equal(streamOverrides.size, 0);
});
