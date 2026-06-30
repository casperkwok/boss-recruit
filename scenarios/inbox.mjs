#!/usr/bin/env node
/**
 * 场景1：新招呼收件箱 端到端编排
 * ───────────────────────────────────────────────────────────────────────────
 * 流程（一人一事务，附件优先 —— 同步只针对附件简历，在线简历仅作打招呼上下文不同步）：
 *   boss recommend → task-memory 选本轮 → 逐个：
 *     ① 风控探针 → ② boss attachment 试附件:
 *          有  → 建/更最小记录(基本信息来自 recommend) + 上传 PDF → synced(通过初筛)；不读在线简历
 *          无  → 读在线简历(仅作称呼/上下文写打招呼，不同步) → 发消息要简历(默认 dry-run,只记本地) → attachment_requested
 *     ③ BatchController 控节奏(随机延时 / 周期风控校验 / 单轮上限 / 连续失败熔断)
 *
 * 用法:
 *   node inbox.mjs                 # 默认: 只读+同步全自动, 打招呼 dry-run(只演示不真发)
 *   node inbox.mjs --limit 5       # 单轮处理上限
 *   node inbox.mjs --live          # 真发要简历消息(对外!需谨慎)
 *   node inbox.mjs --force         # 重扫已处理候选人
 *
 * 前置: opencli doctor 全绿; Chrome 已登录 Boss 招聘端; 已 bind 或自动 bind。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as R from '../lib/rhythm.mjs';
import { TaskMemory, Status } from '../lib/task-memory.mjs';
import * as FS from '../lib/feishu.mjs';
import { loadTarget } from '../lib/target.mjs';
import { SESSION, RHYTHM, RESUME_REQUEST_TEMPLATES } from '../config.mjs';
const pexec = promisify(execFile);

// ── CLI 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const LIVE = has('--live');
const FORCE = has('--force');
const LIMIT = Number(val('--limit', RHYTHM.roundLimit));
const session = val('--session', SESSION);

const log = (m) => console.log(m);
const stamp = () => new Date().toLocaleTimeString('zh-CN');

// ── opencli 调用 ─────────────────────────────────────────────────────────────
async function oc(args, { json = true } = {}) {
  const { stdout } = await pexec('opencli', args, { maxBuffer: 32 * 1024 * 1024, timeout: 90000 });
  if (!json) return stdout;
  const i = stdout.indexOf('[');
  const j = stdout.indexOf('{');
  const start = (i >= 0 && (j < 0 || i < j)) ? i : j;
  return start >= 0 ? JSON.parse(stdout.slice(start)) : null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const tgt = loadTarget();
  if (!tgt) { log('❌ 尚未配置飞书目标表。先运行:\n   node ' + new URL('./setup.mjs', import.meta.url).pathname + ' <飞书表链接>'); process.exit(1); }
  log(`\n🎯 场景1·新招呼收件箱  [${LIVE ? '🔴 LIVE 真发' : '🟢 DRY-RUN 打招呼只演示'}]  上限 ${LIMIT} 人`);
  log(`   同步到: ${tgt.talentTableName} (${tgt.talentTable})${tgt.title ? ' «' + tgt.title + '»' : ''}\n`);

  // 0. 确保 session 绑定到 Boss 页
  try { await pexec('opencli', ['browser', session, 'bind']); } catch { /* 已绑或忽略 */ }

  // 1. 拉新招呼收件箱
  log(`[${stamp()}] 拉取新招呼候选人…`);
  const raw = await oc(['boss', 'recommend', '--limit', String(Math.max(LIMIT * 2, 10)), '--format', 'json']);
  const candidates = (raw || []).map((c) => ({
    uid: c.encrypt_uid, name: c.name, job_name: c.job_name,
    security_id: c.security_id, job_id: c.encrypt_job_id,
    last_time: c.last_time, has_unread: false,   // recommend 无可靠"本轮未读"信号 → 以任务记忆为准
  })).filter((c) => c.uid);
  log(`  收件箱共 ${candidates.length} 人`);

  // 2. 任务记忆选本轮该处理的
  const tm = new TaskMemory();
  const todo = tm.selectForRound(candidates, { force: FORCE }).slice(0, LIMIT);
  log(`  本轮处理 ${todo.length} 人: ${todo.map((c) => c.name).join('、') || '(无新对象)'}\n`);
  if (!todo.length) { log('✅ 没有需要处理的新候选人。'); return; }

  // 3. 批量节奏控制器
  const bc = new R.BatchController({ ...RHYTHM, log });
  const results = [];

  for (const c of todo) {
    if (!bc.canContinue()) { log(`已达单轮上限 ${bc.limit}，停止本轮。`); break; }
    log(`\n── ${c.name} (${c.job_name || '?'}) ──`);
    try {
      await R.assertNoRisk(session, log);                       // ① 风控探针

      // ② 附件优先：核心目的是同步附件简历，不读在线简历
      const at = await oc(['boss', 'attachment', c.uid, '--name', c.name || '', '--format', 'json']);
      const a = (at && at[0]) || {};

      if (a.status === 'downloaded' && a.file) {
        // 有附件 → 建/更最小记录（基本信息来自 recommend）+ 上传 PDF
        const rec = tm.get(c.uid);
        const basic = { name: c.name, job_name: c.job_name };
        const recordId = await FS.syncProfile(basic, Status.SYNCED, rec?.record_id);
        await FS.uploadAttachment(recordId, a.file);
        tm.setStatus(c.uid, Status.SYNCED, { name: c.name, record_id: recordId, resume_file: a.file, job_name: c.job_name });
        log(`  ✓ 附件简历已同步飞书 (${(a.size / 1024).toFixed(0)}KB) → 通过初筛`);
        results.push({ name: c.name, status: 'synced(附件)' });
        bc.success();
      } else {
        // 没附件 → 读在线简历（仅作打招呼的称呼/上下文，不同步飞书）→ 主动要简历
        let profile = {};
        try {
          const rr = await oc(['boss', 'resume', c.uid, '--format', 'json']);
          profile = (rr && rr[0]) || {};
          log(`  档案(仅用于话术): ${profile.gender || '?'} ${profile.experience || ''} ${profile.degree || ''}`);
        } catch { /* 读不到 → 称呼回退"您好" */ }
        const ctx = { ...c, gender: profile.gender, experience: profile.experience, degree: profile.degree, school: profile.school };
        const tpl = RESUME_REQUEST_TEMPLATES[bc.done % RESUME_REQUEST_TEMPLATES.length](ctx);
        if (LIVE) {
          await R.assertNoRisk(session, log);
          await pexec('opencli', ['boss', 'send', c.uid, tpl], { timeout: 90000 });
          tm.setStatus(c.uid, Status.ATTACHMENT_REQUESTED, { name: c.name, job_name: c.job_name, requested_at: new Date().toISOString() });
          log(`  ✉️  已发送要简历消息: 「${tpl.slice(0, 28)}…」`);
          results.push({ name: c.name, status: 'attachment_requested' });
        } else {
          tm.setStatus(c.uid, Status.ATTACHMENT_REQUESTED, { name: c.name, job_name: c.job_name, dry_run: true });
          log(`  📝 [DRY-RUN] 将发送: 「${tpl}」`);
          results.push({ name: c.name, status: 'would_request(dry-run)' });
        }
        bc.success();
      }
    } catch (e) {
      if (e instanceof R.PausedError) {
        log(`\n⏸️  暂停 [${e.state}]: ${e.detail}`);
        results.push({ name: c.name, status: e.state });
        break;     // 熔断/暂停：停整轮，保留进度
      }
      log(`  ❌ 处理异常: ${String(e.message).slice(0, 120)}`);
      results.push({ name: c.name, status: 'error' });
    }
    await bc.betweenActions(session);     // 一人一事务之间：随机延时 + 周期校验
  }

  // 6. 汇报
  log(`\n${'═'.repeat(50)}\n📊 本轮汇报`);
  log(`  处理 ${bc.summary().processed} 人, 成功 ${bc.summary().success}`);
  for (const r of results) log(`   · ${r.name}: ${r.status}`);
  const st = tm.stats();
  log(`  记忆库累计 ${st.total} 人: ${JSON.stringify(st.by)}`);
  log(`  记忆文件: ${tm.file}`);
  if (!LIVE) log(`\n💡 打招呼为 DRY-RUN。确认话术/节奏后加 --live 真发。`);
}

main().catch((e) => { console.error('\n💥 编排失败:', e); process.exit(1); });
