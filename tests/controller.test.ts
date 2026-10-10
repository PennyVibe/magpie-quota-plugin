import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { PanelController } from '../widget/controller';
import { deferred } from './fixtures';

test('读取忽略取消时仍丢弃旧成功和旧错误，串行补读最新状态', async () => {
  for (const fail of [false, true]) {
    const gates = [deferred<void>(), deferred<void>()], signals: AbortSignal[] = [], applied: unknown[] = [];
    const controller = new PanelController(async signal => {
      const index = signals.length; signals.push(signal);
      await gates[index].promise;
      if (index === 0 && fail) throw Error('旧请求失败');
      return index;
    }, value => { applied.push(value); });
    try {
      controller.start(true); controller.invalidate(); void controller.refresh();
      assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true);
      gates[0].resolve(); await setImmediate();
      assert.deepEqual(applied, [], fail ? '旧错误不能覆盖新状态' : '旧成功不能覆盖新状态');
      assert.equal(signals.length, 2);
      gates[1].resolve(); await setImmediate();
      assert.deepEqual(applied, [1]);
    } finally {
      controller.stop(); gates.forEach(gate => gate.resolve()); await setImmediate();
    }
  }
});
