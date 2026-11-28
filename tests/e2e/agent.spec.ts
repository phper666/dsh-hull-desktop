/**
 * Agent 页真实 Electron e2e（U-002 / Agent UI）：
 *   ① 导航与连接（壳 nav-agent → 主进程切 placeholder:agent → 连接外部 ACP agent）
 *   ② 发送与流式（Enter 发送 → agent_message_chunk 落到 #ag-msgs → 回合结束后状态回到「已连接」）
 *   ③ 同会话多轮（fake agent 第 N≥2 轮回复带 TURN_N，证明未重建会话）
 *   ④ 审批往返（ASK_PERMISSION → session/request_permission → 允许 → 模态消失 + 该轮完成）
 *   ⑤ 新会话（#ag-new → 会话 chip 变化 + 消息清空 + 保持已连接）
 * 注入：HULL_USER_DATA 临时目录 + HULL_E2E + settings.externalAgent 指向 fake-acp-agent fixture
 *      （真实 spawn：process.execPath = runner 的 node 绝对路径）。
 * 注意：agent 会话是长驻进程，每个 test 独立 launch/close，共享会话的用例串在同一个 test 内。
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

import {
  PROJECT_ROOT,
  launchApp,
  makeTempUserData,
  seedFakeDsh,
  seedSettings,
  waitForReady,
} from './helpers';

/** ACP 替身绝对路径（prompt 含 ASK_PERMISSION 时发 permission REQUEST；同会话第 N≥2 轮带 TURN_N） */
const FAKE_ACP_PATH = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-acp-agent.js');

interface AgentApp {
  app: ElectronApplication;
  shell: Page;
  ud: ReturnType<typeof makeTempUserData>;
}

/** 启动壳 + settings 指向 fake ACP agent + 进入 Agent 页（section#agent 可见） */
async function launchAgentApp(): Promise<AgentApp> {
  const ud = makeTempUserData();
  seedFakeDsh(ud.dir);
  seedSettings(ud.dir, {
    externalAgent: {
      enabled: true,
      name: 'fake-agent',
      // 引号包裹防路径含空格（parseLaunchCommand 支持双引号）
      command: `"${process.execPath}" "${FAKE_ACP_PATH}"`,
    },
  });
  const app = await launchApp({ userData: ud.dir });
  const shell = await waitForReady(app);
  await shell.click('#nav-agent');
  await expect(shell.locator('#agent')).toBeVisible();
  return { app, shell, ud };
}

async function closeAgentApp(ctx: AgentApp): Promise<void> {
  await ctx.app.close().catch(() => {});
  ctx.ud.cleanup();
}

/** 发送一条消息（fill + Enter；输入框在 busy/未连接时 disabled，调用前需等待可写） */
async function sendMessage(shell: Page, text: string): Promise<void> {
  await expect(shell.locator('#ag-input')).toBeEnabled({ timeout: 15_000 });
  await shell.fill('#ag-input', text);
  await shell.locator('#ag-input').press('Enter');
}

test.describe('Agent 页（外部 ACP agent 真实进程）', () => {
  test.describe.configure({ timeout: 60_000 });

  test('导航/连接/流式/同会话多轮/审批往返', async () => {
    const ctx = await launchAgentApp();
    const { shell } = ctx;
    try {
      // ── ① 导航与连接 ──
      // 不是只高亮 nav：主进程 hull:showAgent 切 view 后 section#agent 才显示
      await expect(shell.locator('#agent-root')).toBeVisible();
      await expect(shell.locator('#nav-agent')).toHaveClass(/active/);
      await shell.click('#ag-connect');
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 10_000 });
      // initialize 返回 agentInfo.name = fake-acp-agent
      await expect(shell.locator('#ag-name')).toHaveText('fake-acp-agent');

      // ── ② 发送与流式 ──
      await sendMessage(shell, '你好');
      await expect(shell.locator('#ag-msgs')).toContainText('FAKE_AGENT_REPLY', { timeout: 15_000 });
      // 回合结束（turn_end → status idle）后状态回「已连接」（busy 时是「思考中」）
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 15_000 });

      // ── ③ 同会话多轮 ──
      await sendMessage(shell, '再来一轮');
      await expect(shell.locator('#ag-msgs')).toContainText('TURN_2', { timeout: 15_000 });
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 15_000 });

      // ── ④ 审批往返 ──
      await sendMessage(shell, 'ASK_PERMISSION 请授权');
      await expect(shell.locator('#ag-approve')).toBeVisible({ timeout: 10_000 });
      await shell.click('#ag-approve-allow');
      // 模态关闭（wrap.remove）+ 批准分支继续执行 → 该轮完成
      await expect(shell.locator('#ag-approve')).toHaveCount(0, { timeout: 10_000 });
      await expect(shell.locator('#ag-msgs')).toContainText('权限已批准', { timeout: 10_000 });
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 10_000 });
    } finally {
      await closeAgentApp(ctx);
    }
  });

  test('新会话：会话 chip 变化 + 消息清空 + 保持已连接', async () => {
    const ctx = await launchAgentApp();
    const { shell } = ctx;
    try {
      await shell.click('#ag-connect');
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 10_000 });

      // 先产生一轮对话与会话 id
      await sendMessage(shell, '你好');
      await expect(shell.locator('#ag-msgs')).toContainText('FAKE_AGENT_REPLY', { timeout: 15_000 });
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 15_000 });
      await expect(shell.locator('#ag-sid')).toBeVisible();
      const firstSid = (await shell.locator('#ag-sid-txt').textContent())?.trim() ?? '';
      expect(firstSid).toMatch(/^[0-9a-f]{8}$/i); // shortId(sessionId) = uuid 前 8 位

      await shell.click('#ag-new');

      // 新会话 = close + start：chip 显示新 shortId（旧 process 已换）
      await expect(shell.locator('#ag-sid')).toBeVisible({ timeout: 15_000 });
      await expect(shell.locator('#ag-sid-txt')).not.toHaveText(firstSid, { timeout: 15_000 });
      const secondSid = (await shell.locator('#ag-sid-txt').textContent())?.trim() ?? '';
      expect(secondSid).toMatch(/^[0-9a-f]{8}$/i);
      expect(secondSid).not.toBe(firstSid);

      // 消息流清空（resetMessages）且保持已连接
      await expect(shell.locator('#ag-msgs .ag-msg')).toHaveCount(0);
      await expect(shell.locator('#ag-state-txt')).toHaveText('已连接', { timeout: 10_000 });
    } finally {
      await closeAgentApp(ctx);
    }
  });
});
