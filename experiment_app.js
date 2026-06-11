import { TouchHandler } from './js/TouchHandler.js';

/**
 * 5本指上げ実験アプリ v2
 * 1〜4本指の全30通りの組み合わせについて，上げやすさを計測する
 */

const FINGER_NAMES = ['親指', '人差し指', '中指', '薬指', '小指'];
const TRIALS_PER_COMBO = 2; // 30通り × 2回 = 60試行

/** k-combinations of arr */
function kCombinations(arr, k) {
    if (k === 1) return arr.map(x => [x]);
    const result = [];
    for (let i = 0; i <= arr.length - k; i++)
        for (const rest of kCombinations(arr.slice(i + 1), k - 1))
            result.push([arr[i], ...rest]);
    return result;
}

// 1本(5通り) + 2本(10通り) + 3本(10通り) + 4本(5通り) = 30通り
const ALL_COMBINATIONS = [1, 2, 3, 4].flatMap(k => kCombinations([0,1,2,3,4], k));
const TOTAL_TRIALS = ALL_COMBINATIONS.length * TRIALS_PER_COMBO; // 60
const PROMPT_DELAY_MS      = 800;   // 5本指検出 → 指示表示までの待機時間
const FEEDBACK_DURATION_MS = 1800;  // 結果フィードバック表示時間
const COUNTDOWN_FROM       = 3;     // カウントダウン開始値
const COUNTDOWN_INTERVAL   = 1000;  // カウント間隔 (ms)

class ExperimentApp {
    constructor() {
        this.touchArea  = document.getElementById('touchArea');
        this.touchHandler = new TouchHandler();

        this.handType           = null;
        this.phase              = 'hand_selection';
        this.activeCombinations = null;
        this.countdownTimer     = null;  // 選択された本数に対応する組み合わせ
        this.initialFingers     = null;
        this.trialQueue         = [];
        this.currentTrial       = null;  // {targetFingers, startTime, firstLiftTime}
        this.removedFingers     = [];    // 今の試行で離れた指
        this.trials             = [];
        this.promptTimer        = null;

        this.init();
    }

    // ─── 初期化 ───────────────────────────────────────────────

    init() {
        document.getElementById('leftHandBtn').addEventListener('click', () => this.selectHand('left'));
        document.getElementById('rightHandBtn').addEventListener('click', () => this.selectHand('right'));
        document.getElementById('count1Btn').addEventListener('click', () => this.selectFingerCount(1));
        document.getElementById('count2Btn').addEventListener('click', () => this.selectFingerCount(2));
        document.getElementById('count3Btn').addEventListener('click', () => this.selectFingerCount(3));
        document.getElementById('count4Btn').addEventListener('click', () => this.selectFingerCount(4));
        document.getElementById('countAllBtn').addEventListener('click', () => this.selectFingerCount('all'));
        document.getElementById('resetBtn').addEventListener('click', () => this.reset());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportJSON());

        const opts = { passive: false };
        this.touchArea.addEventListener('touchstart',  e => this.onTouchStart(e),  opts);
        this.touchArea.addEventListener('touchmove',   e => this.onTouchMove(e),   opts);
        this.touchArea.addEventListener('touchend',    e => this.onTouchEnd(e),    opts);
        this.touchArea.addEventListener('touchcancel', e => this.onTouchEnd(e),    opts);
    }

    // ─── 手の選択 ─────────────────────────────────────────────

    get totalTrials() {
        return (this.activeCombinations || ALL_COMBINATIONS).length * TRIALS_PER_COMBO;
    }

    selectHand(hand) {
        this.handType = hand;
        document.getElementById('handSelection').style.display   = 'none';
        document.getElementById('mainPanel').style.display        = 'block';
        document.getElementById('fingerCountSelection').style.display = 'block';
        document.getElementById('experimentPanel').style.display  = 'none';
        this.setInstruction('使用する指の本数を選択してください', '', '');
    }

    selectFingerCount(k) {
        this.activeCombinations = k === 'all'
            ? ALL_COMBINATIONS
            : ALL_COMBINATIONS.filter(c => c.length === k);
        this.phase = 'waiting_5fingers';
        document.getElementById('fingerCountSelection').style.display = 'none';
        document.getElementById('experimentPanel').style.display      = 'block';
        document.getElementById('handType').textContent = this.handType === 'left' ? '左手' : '右手';
        this.setInstruction('5本の指を全てタッチエリアに置いてください', '', '');
        this.updateProgress();
        this.updateHandIllustration([]);
    }

    // ─── タッチイベント ───────────────────────────────────────

    onTouchStart(e) {
        e.preventDefault();
        if (this.phase === 'hand_selection') return;

        this.touchHandler.addTouches(e, this.touchArea.getBoundingClientRect());
        this.updateTouchCount();
        this.renderTouches();

        if (this.touchHandler.size === 5 &&
            (this.phase === 'waiting_5fingers' || this.phase === 'between_trials')) {
            this.detect5Fingers();
        }
    }

    onTouchMove(e) {
        e.preventDefault();
        this.touchHandler.updatePositions(e, this.touchArea.getBoundingClientRect());
        this.renderTouches();
    }

    onTouchEnd(e) {
        e.preventDefault();
        if (this.phase === 'hand_selection') return;

        const phaseBefore = this.phase;
        this.touchHandler.removeTouches(e);
        this.updateTouchCount();
        this.renderTouches();

        if (phaseBefore === 'trial_prompt') {
            this.trackLift(e);
        } else if (phaseBefore === '5fingers_detected' && this.touchHandler.size < 5) {
            if (this.promptTimer) { clearTimeout(this.promptTimer); this.promptTimer = null; }
            this.initialFingers = null;
            this.phase = 'waiting_5fingers';
            this.setInstruction('指が離れました。もう一度5本置いてください', '', '');
        }
    }

    // ─── 5本指検出 ────────────────────────────────────────────

    detect5Fingers() {
        const touches = Array.from(this.touchHandler.activeTouches.values());
        const sorted  = [...touches].sort((a, b) => a.x - b.x);
        if (this.handType === 'left') sorted.reverse();

        // x 座標順に親指→小指を割り当て
        this.initialFingers = sorted.map((t, i) => ({
            touchId: t.id, x: t.x, y: t.y,
            finger: i, name: FINGER_NAMES[i]
        }));

        this.phase = '5fingers_detected';
        this.setInstruction('5本指を検出しました！', 'このまま指を置いておいてください…', 'detected');
        this.renderTouches();

        this.promptTimer = setTimeout(() => this.startNextTrial(), PROMPT_DELAY_MS);
    }

    // ─── 試行管理 ─────────────────────────────────────────────

    generateTrialQueue() {
        const q = [];
        for (let j = 0; j < TRIALS_PER_COMBO; j++)
            for (const combo of this.activeCombinations) q.push([...combo]);
        for (let i = q.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [q[i], q[j]] = [q[j], q[i]];
        }
        return q;
    }

    startNextTrial() {
        if (this.trialQueue.length === 0) this.trialQueue = this.generateTrialQueue();
        const targetFingers = this.trialQueue.shift();
        this.currentTrial   = {
            targetFingers,
            trackingStart:    null,  // カウント2になった瞬間
            scheduledGoTime:  null,  // カウント0（GO）の予定時刻
            startTime:        null,  // 実際のGO時刻（scheduledGoTime≈startTime）
            firstLiftTime:    null
        };
        this.removedFingers = [];
        this.phase = 'trial_prompt';

        const instruction = this.formatInstruction(targetFingers);
        const sub = `GOが出たら上げてください ／ 試行 ${this.trials.length + 1} / ${this.totalTrials}`;
        this.setInstruction(instruction, sub, 'prompt');
        this.updateHandIllustration(targetFingers);
        this.renderTouches();
        this.runCountdown(COUNTDOWN_FROM);
    }

    formatInstruction(targetFingers) {
        const names = targetFingers.map(i => FINGER_NAMES[i]);
        if (names.length === 1) {
            return `「${names[0]}」を上げてください`;
        } else if (names.length === 4) {
            const keep = FINGER_NAMES.filter((_, i) => !targetFingers.includes(i));
            return `「${keep[0]}」だけ残してください`;
        } else {
            return `「${names.join('」「')}」を上げてください`;
        }
    }

    // ─── カウントダウン ───────────────────────────────────────

    runCountdown(n) {
        const el    = document.getElementById('countdown');
        const isGo  = (n === 0);
        el.textContent = isGo ? 'GO' : String(n);
        el.style.color = isGo ? '#4caf50' : (n === 1 ? '#ff9800' : '#1a1a2e');
        el.style.display = 'block';

        if (n === 2) {
            // カウント2からデータ収集開始，GO予定時刻を記録
            this.currentTrial.trackingStart   = performance.now();
            this.currentTrial.scheduledGoTime = performance.now() + n * COUNTDOWN_INTERVAL;
        }

        if (isGo) {
            this.currentTrial.startTime = performance.now();
            // GOは指を離すまで表示したままにする
            const names = this.currentTrial.targetFingers.map(i => FINGER_NAMES[i]).join('・');
            this.setInstruction(`今すぐ「${names}」を上げて！`, '', 'detected');
        } else {
            this.countdownTimer = setTimeout(() => this.runCountdown(n - 1), COUNTDOWN_INTERVAL);
        }
    }

    hideCountdown() {
        document.getElementById('countdown').style.display = 'none';
    }

    abortCountdown() {
        if (this.countdownTimer) { clearTimeout(this.countdownTimer); this.countdownTimer = null; }
        this.hideCountdown();
        this.initialFingers = null;
        this.phase = 'waiting_5fingers';
        this.setInstruction('早すぎます！もう一度5本置いてください', '', '');
        this.updateHandIllustration([]);
    }

    // ─── 複数指の上げ検出 ─────────────────────────────────────

    trackLift(e) {
        if (!this.initialFingers || !this.currentTrial) return;

        // カウント2より前の早上げはアボート
        if (!this.currentTrial.trackingStart) {
            this.abortCountdown();
            return;
        }

        const removedIds = new Set(Array.from(e.changedTouches).map(t => t.identifier));
        for (const f of this.initialFingers) {
            if (removedIds.has(f.touchId) && !this.removedFingers.find(r => r.finger === f.finger)) {
                if (!this.removedFingers.length)
                    this.currentTrial.firstLiftTime = performance.now();
                this.removedFingers.push({ finger: f.finger, name: f.name, liftTime: performance.now() });
            }
        }

        if (this.removedFingers.length >= this.currentTrial.targetFingers.length) {
            this.completeLift();
        }
    }

    completeLift() {
        // カウントダウンを止める
        if (this.countdownTimer) { clearTimeout(this.countdownTimer); this.countdownTimer = null; }
        this.hideCountdown();

        // RT基準はGO予定時刻（GOより早ければ負の値）
        const goRef   = this.currentTrial.scheduledGoTime;
        const now     = performance.now();
        const rt      = Math.round(now - goRef);
        const firstRT = this.currentTrial.firstLiftTime
            ? Math.round(this.currentTrial.firstLiftTime - goRef)
            : rt;
        const targetSorted  = [...this.currentTrial.targetFingers].sort((a,b) => a-b);
        const liftedFingers = this.removedFingers.map(f => f.finger).sort((a,b) => a-b);
        const correct = JSON.stringify(liftedFingers) === JSON.stringify(targetSorted);

        // 指ごとの個別RT（GOからの時間）
        const fingerLiftDetails = this.removedFingers.map(f => ({
            finger: f.finger,
            name:   f.name,
            rtMs:   Math.round(f.liftTime - goRef)
        }));
        // 指間非同期: 最初と最後の指の時間差
        const liftRTs  = fingerLiftDetails.map(f => f.rtMs);
        const asyncMs  = liftRTs.length > 1 ? Math.max(...liftRTs) - Math.min(...liftRTs) : 0;

        this.trials.push({
            trialNo:           this.trials.length + 1,
            targetFingers:     targetSorted,
            targetNames:       targetSorted.map(i => FINGER_NAMES[i]),
            targetKey:         targetSorted.join('-'),
            fingerCount:       targetSorted.length,
            liftedFingers,
            liftedNames:       liftedFingers.map(i => FINGER_NAMES[i]),
            correct,
            reactionTime:      rt,       // 最後の指がGOから何ms
            firstLiftTime:     firstRT,  // 最初の指がGOから何ms
            asyncMs,                     // 最初〜最後の指の時間差
            fingerLiftDetails            // 各指の個別RT
        });

        this.phase = 'lift_detected';
        this.initialFingers = null;
        this.updateProgress();

        if (correct) {
            const names = targetSorted.map(i => FINGER_NAMES[i]).join('・');
            this.setInstruction(`✓ 正解！ ${names}を上げました`, '', 'correct');
            this.showFeedback('✓', true);
        } else {
            const lifted = liftedFingers.map(i => FINGER_NAMES[i]).join('・');
            const target = targetSorted.map(i => FINGER_NAMES[i]).join('・');
            this.setInstruction(`✗ ${lifted}を上げました`, `正解: ${target}`, 'wrong');
            this.showFeedback('✗', false);
        }

        setTimeout(() => {
            this.hideFeedback();
            if (this.trials.length >= this.totalTrials) {
                this.showResults();
            } else {
                this.phase = 'between_trials';
                this.updateHandIllustration([]);
                this.setInstruction(
                    '5本の指を全て置いてください',
                    `試行 ${this.trials.length + 1} / ${this.totalTrials}`,
                    ''
                );
            }
        }, FEEDBACK_DURATION_MS);
    }

    // ─── 集計 ──────────────────────────────────────────────────

    computeStats() {
        return ALL_COMBINATIONS.map(combo => {
            const key      = combo.join('-');
            const ft       = this.trials.filter(t => t.targetKey === key);
            const correctT = ft.filter(t =>  t.correct);
            const errorT   = ft.filter(t => !t.correct);
            const avgRT        = ft.length       ? Math.round(ft.reduce((s,t)=>s+t.reactionTime,0)/ft.length)       : null;
            const avgCorrectRT = correctT.length ? Math.round(correctT.reduce((s,t)=>s+t.reactionTime,0)/correctT.length) : null;
            const avgErrorRT   = errorT.length   ? Math.round(errorT.reduce((s,t)=>s+t.reactionTime,0)/errorT.length)   : null;
            const accuracy     = ft.length ? Math.round(correctT.length/ft.length*100) : null;

            const errorBreakdown = [];
            for (const et of errorT) {
                const lKey  = et.liftedFingers.join('-');
                const entry = errorBreakdown.find(e => e.liftedKey === lKey);
                if (entry) entry.count++;
                else errorBreakdown.push({ liftedKey: lKey, liftedNames: et.liftedNames, count: 1 });
            }
            errorBreakdown.sort((a,b) => b.count - a.count);

            return {
                combo, key,
                names:       combo.map(i => FINGER_NAMES[i]),
                fingerCount: combo.length,
                correct:     correctT.length,
                errors:      errorT.length,
                total:       ft.length,
                accuracy, avgRT, avgCorrectRT, avgErrorRT,
                errorBreakdown
            };
        });
    }

    // ─── 結果表示 ─────────────────────────────────────────────

    showResults() {
        this.phase = 'results';
        this.setInstruction('実験終了です', '実験者に声をかけてください', 'detected');

        // テーブルはバックグラウンドで集計のみ（参加者には非表示）
        const stats = this.computeStats();
        const groupBody = document.getElementById('groupSummaryBody');
        groupBody.innerHTML = '';
        [1, 2, 3, 4].forEach(k => {
            const gs = stats.filter(s => s.fingerCount === k && s.total > 0);
            if (!gs.length) return;
            const totalCorrect = gs.reduce((s,x) => s + x.correct, 0);
            const totalAll     = gs.reduce((s,x) => s + x.total,   0);
            const validRT      = gs.filter(s => s.avgRT !== null);
            const avgRT = validRT.length
                ? Math.round(validRT.reduce((s,x) => s + x.avgRT, 0) / validRT.length)
                : '-';
            const acc = Math.round(totalCorrect / totalAll * 100);
            const tr  = document.createElement('tr');
            tr.innerHTML = `<td>${k}本指</td><td>${acc}%</td><td>${avgRT} ms</td>`;
            groupBody.appendChild(tr);
        });
        const tbody = document.getElementById('resultsBody');
        tbody.innerHTML = '';
        stats.forEach(s => {
            if (!s.total) return;
            const tr = document.createElement('tr');
            const accClass  = s.accuracy < 100 ? 'worst' : 'best';
            const errorCell = s.errorBreakdown.length
                ? s.errorBreakdown.map(e => `${e.liftedNames.join('・')}×${e.count}`).join('、')
                : 'なし';
            tr.innerHTML = `
                <td>${s.names.join('・')}</td>
                <td class="${accClass}">${s.correct}/${s.total}（${s.accuracy}%）</td>
                <td>${s.avgRT} ms</td>
                <td>${errorCell}</td>
            `;
            tbody.appendChild(tr);
        });

        // 参加者にはテーブルを見せない。エクスポートボタンのみ表示
        document.getElementById('resultsSection').style.display = 'none';
        document.getElementById('exportBtn').style.display = 'block';
        this.updateHandIllustration([]);
    }

    // ─── JSON エクスポート ────────────────────────────────────

    exportJSON() {
        const hand = this.handType === 'left' ? '左手' : '右手';
        const now  = new Date();

        const summary = this.computeStats().map(s => ({
            fingerCount:              s.fingerCount,
            combo:                    s.combo,
            fingerNames:              s.names,
            correct:                  s.correct,
            errors:                   s.errors,
            total:                    s.total,
            accuracyPct:              s.accuracy,
            avgReactionTimeMs:        s.avgRT,
            avgCorrectReactionTimeMs: s.avgCorrectRT,
            avgErrorReactionTimeMs:   s.avgErrorRT,
            errorBreakdown:           s.errorBreakdown
        }));

        const output = {
            meta: {
                appVersion:        '2.0',
                exportedAt:        now.toISOString(),
                hand,
                trialsPerCombo:    TRIALS_PER_COMBO,
                totalCombinations: ALL_COMBINATIONS.length,
                totalTrials:       TOTAL_TRIALS
            },
            summary,
            trials: this.trials
        };

        const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `finger_lift_${hand}_${now.toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ─── 描画 ─────────────────────────────────────────────────

    renderTouches() {
        this.touchArea.querySelectorAll('.touch-point').forEach(p => p.remove());

        for (const touch of this.touchHandler.activeTouches.values()) {
            const pt = document.createElement('div');
            pt.className = 'touch-point';
            pt.style.left = touch.x + 'px';
            pt.style.top  = touch.y + 'px';

            if (this.initialFingers) {
                const id = this.initialFingers.find(f => f.touchId === touch.id);
                if (id) {
                    pt.classList.add('identified');
                    if (this.currentTrial && id.finger === this.currentTrial.targetFinger) {
                        pt.classList.add('target');
                    }
                    pt.textContent = id.name[0]; // 親/人/中/薬/小
                } else {
                    pt.textContent = '●';
                }
            } else {
                pt.textContent = '●';
            }
            this.touchArea.appendChild(pt);
        }
    }

    // ─── UI ヘルパー ──────────────────────────────────────────

    setInstruction(main, sub, type) {
        const el = document.getElementById('instruction');
        el.className = 'instruction' + (type ? ' ' + type : '');
        el.querySelector('.main').textContent = main;
        el.querySelector('.sub').textContent  = sub;
    }

    showFeedback(text, correct) {
        const el = document.getElementById('feedback');
        const handClass = this.handType === 'left' ? 'hand-left' : 'hand-right';
        el.className = `feedback ${handClass} ${correct ? 'correct' : 'wrong'}`;
        el.textContent = text;
        el.style.display = 'block';
    }

    hideFeedback() {
        document.getElementById('feedback').style.display = 'none';
    }

    updateHandIllustration(targetFingers = []) {
        const hint = document.getElementById('handHint');
        if (this.phase === 'hand_selection') { hint.style.display = 'none'; return; }
        hint.style.display = 'block';

        // 左手は水平鏡像表示
        document.getElementById('handGroup').setAttribute(
            'transform',
            this.handType === 'left' ? 'translate(65,0) scale(-1,1)' : ''
        );

        for (let i = 0; i < 5; i++) {
            const el = document.getElementById(`hand-f${i}`);
            el.setAttribute('fill', targetFingers.includes(i) ? '#ff9800' : '#90a4ae');
        }
    }

    updateTouchCount() {
        document.getElementById('touchCount').textContent = this.touchHandler.size;
    }

    updateProgress() {
        const done  = this.trials.length;
        const total = this.totalTrials;
        document.getElementById('trialCount').textContent = `${done}/${total}`;
        document.getElementById('progressText').textContent = `${done} / ${total} 試行`;
        document.getElementById('progressBar').style.width = `${(done / total) * 100}%`;
    }

    // ─── リセット ─────────────────────────────────────────────

    reset() {
        if (this.promptTimer) { clearTimeout(this.promptTimer); this.promptTimer = null; }
        this.touchHandler.clear();
        this.handType       = null;
        this.phase          = 'hand_selection';
        this.initialFingers = null;
        this.trialQueue     = [];
        this.currentTrial   = null;
        this.removedFingers = [];
        this.trials         = [];

        this.activeCombinations = null;
        if (this.countdownTimer) { clearTimeout(this.countdownTimer); this.countdownTimer = null; }
        this.hideCountdown();
        document.getElementById('handHint').style.display             = 'none';
        document.getElementById('handSelection').style.display        = 'flex';
        document.getElementById('mainPanel').style.display            = 'none';
        document.getElementById('fingerCountSelection').style.display = 'block';
        document.getElementById('experimentPanel').style.display      = 'none';
        document.getElementById('resultsSection').style.display       = 'none';
        document.getElementById('exportBtn').style.display            = 'none';

        this.setInstruction('使用する手を選択してください', '', '');
        this.hideFeedback();
        this.renderTouches();
    }
}

document.addEventListener('DOMContentLoaded', () => new ExperimentApp());
