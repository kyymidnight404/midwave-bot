import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../src/managers/SessionManager.js';
import { InviteManager } from '../../src/managers/InviteManager.js';
import { GameManager } from '../../src/managers/GameManager.js';
import { GAME_MODES, MATCH_STATUS } from '../../src/utils/constants.js';
import { createSeededRng } from '../../src/utils/random.js';

function createDummyEngine() {
  return {
    create(_config, players) {
      return {
        mode: players.includes('BOT') ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER,
        players,
        currentTurn: players[0],
        count: 0,
        status: MATCH_STATUS.ACTIVE,
      };
    },
    applyAction(state, playerId, action) {
      if (state.status !== MATCH_STATUS.ACTIVE) {
        return { error: 'Game sudah selesai.' };
      }
      if (action.type === 'increment') {
        const nextCount = state.count + 1;
        const finished = nextCount >= (action.target ?? 3);
        const nextState = {
          ...state,
          count: nextCount,
          status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.ACTIVE,
        };
        return {
          state: nextState,
          finished,
          result: finished
            ? {
                winnerId: playerId,
                loserId: state.players.find((p) => p !== playerId),
                isDraw: false,
                description: 'Selesai',
              }
            : null,
        };
      }
      return { error: 'Aksi tidak dikenal' };
    },
    getPublicView(state) {
      return {
        mode: state.mode,
        players: state.players,
        status: state.status,
        currentTurn: state.currentTurn,
        boardOrInfo: `Count: ${state.count}`,
      };
    },
    getPrivateView() {
      return {};
    },
  };
}

describe('SessionManager', () => {
  it('creates, updates, and idempotently ends sessions for finished/cancelled/timeout', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sm = new SessionManager({ maxSessions: 5, defaultIdleTimeoutMs: 5000 });

    // 1. Finished cleanup
    let disposed1 = 0;
    let extraTimerFired = false;
    const s1 = sm.createSession({
      gameType: 'guess',
      mode: GAME_MODES.SOLO,
      channelId: 'ch1',
      players: ['u1', 'BOT'],
      state: { count: 0 },
    });
    sm.addDisposer(s1.sessionId, () => {
      disposed1 += 1;
    });
    const extraTimer = setTimeout(() => {
      extraTimerFired = true;
    }, 1000);
    sm.registerTimer(s1.sessionId, extraTimer);

    assert.deepEqual(sm.getStats(), { activeGamesCount: 1, playerSessionsCount: 1 });
    sm.endSession(s1.sessionId, MATCH_STATUS.FINISHED);
    // Calling endSession twice is safe and idempotent
    assert.equal(sm.endSession(s1.sessionId, MATCH_STATUS.FINISHED), null);

    t.mock.timers.tick(6000);
    assert.equal(disposed1, 1);
    assert.equal(extraTimerFired, false);
    assert.deepEqual(sm.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });

    // 2. Cancelled cleanup
    let disposed2 = 0;
    const s2 = sm.createSession({
      gameType: 'rps',
      mode: GAME_MODES.MULTIPLAYER,
      channelId: 'ch1',
      players: ['u1', 'u2'],
      state: {},
    });
    sm.addDisposer(s2.sessionId, () => {
      disposed2 += 1;
    });
    sm.endSession(s2.sessionId, MATCH_STATUS.CANCELLED);
    assert.equal(disposed2, 1);
    assert.deepEqual(sm.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });

    // 3. Timeout cleanup
    let timedOutSession = null;
    sm.createSession({
      gameType: 'guess',
      mode: GAME_MODES.MULTIPLAYER,
      channelId: 'ch1',
      players: ['u3', 'u4'],
      state: {},
      onTimeout: (closed) => {
        timedOutSession = closed;
      },
    });
    t.mock.timers.tick(5000);
    assert.ok(timedOutSession);
    assert.equal(timedOutSession.status, MATCH_STATUS.TIMEOUT);
    assert.deepEqual(sm.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });
  });

  it('prevents duplicate active sessions per player and enforces maxSessions', () => {
    const sm = new SessionManager({ maxSessions: 1, defaultIdleTimeoutMs: 0 });
    const s1 = sm.createSession({
      gameType: 'guess',
      mode: GAME_MODES.SOLO,
      channelId: 'c1',
      players: ['u1', 'BOT'],
      state: {},
    });
    assert.throws(() => {
      sm.createSession({
        gameType: 'rps',
        mode: GAME_MODES.SOLO,
        channelId: 'c1',
        players: ['u2', 'BOT'],
        state: {},
      });
    }, /penuh/);

    sm.endSession(s1.sessionId);
    const sm2 = new SessionManager({ maxSessions: 5, defaultIdleTimeoutMs: 0 });
    sm2.createSession({
      gameType: 'guess',
      mode: GAME_MODES.SOLO,
      channelId: 'c1',
      players: ['u1', 'BOT'],
      state: {},
    });
    assert.throws(() => {
      sm2.createSession({
        gameType: 'rps',
        mode: GAME_MODES.MULTIPLAYER,
        channelId: 'c1',
        players: ['u1', 'u2'],
        state: {},
      });
    }, /sudah berada/);
    sm2.clearAll();
  });
});

describe('InviteManager', () => {
  it('handles create, accept, decline, cancel, and TTL expiration', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sm = new SessionManager({ defaultIdleTimeoutMs: 0 });
    const im = new InviteManager({ sessionManager: sm, defaultTtlMs: 3000 });

    let expiredCalled = false;
    im.createInvite({
      gameType: 'rps',
      channelId: 'ch1',
      hostId: 'u1',
      opponentId: 'u2',
      onExpire: () => {
        expiredCalled = true;
      },
    });
    assert.equal(im.count, 1);

    // Duplicate outgoing or incoming invite blocked
    assert.throws(() => {
      im.createInvite({ gameType: 'rps', channelId: 'ch1', hostId: 'u1', opponentId: 'u3' });
    });
    assert.throws(() => {
      im.createInvite({ gameType: 'rps', channelId: 'ch1', hostId: 'u4', opponentId: 'u2' });
    });

    t.mock.timers.tick(3000);
    assert.equal(expiredCalled, true);
    assert.equal(im.count, 0);

    // Decline clears invite
    im.createInvite({ gameType: 'rps', channelId: 'ch1', hostId: 'u1', opponentId: 'u2' });
    const declined = im.declineInvite('u2');
    assert.equal(declined.hostId, 'u1');
    assert.equal(im.count, 0);

    // Host cancel clears invite
    im.createInvite({ gameType: 'rps', channelId: 'ch1', hostId: 'u1', opponentId: 'u2' });
    const cancelled = im.cancelOutgoingInvite('u1');
    assert.equal(cancelled.opponentId, 'u2');
    assert.equal(im.count, 0);

    // Accept returns invite and cleans map
    im.createInvite({ gameType: 'rps', channelId: 'ch1', hostId: 'u1', opponentId: 'u2' });
    const accepted = im.acceptInvite('u2');
    assert.equal(accepted.hostId, 'u1');
    assert.equal(im.count, 0);
  });
});

describe('GameManager & Concurrency Lock', () => {
  it('serializes concurrent multiplayer actions without race condition', async () => {
    const sm = new SessionManager({ defaultIdleTimeoutMs: 0 });
    const im = new InviteManager({ sessionManager: sm, defaultTtlMs: 0 });
    const gm = new GameManager({ sessionManager: sm, inviteManager: im, rng: createSeededRng(1) });
    gm.registerGame('dummy', createDummyEngine());

    gm.createChallenge({
      gameType: 'dummy',
      channelId: 'ch1',
      hostId: 'p1',
      opponentId: 'p2',
    });
    const { session } = gm.acceptChallenge('p2');
    assert.ok(session);

    // Fire 3 actions concurrently; target is 3, so only the 3rd finishes the game,
    // and any extra action after finish receives an error instead of double-finishing.
    const results = await Promise.allSettled([
      gm.submitAction('p1', 'dummy', { type: 'increment', target: 3 }),
      gm.submitAction('p2', 'dummy', { type: 'increment', target: 3 }),
      gm.submitAction('p1', 'dummy', { type: 'increment', target: 3 }),
      gm.submitAction('p2', 'dummy', { type: 'increment', target: 3 }),
    ]);

    const fulfilled = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);
    const finishedCount = fulfilled.filter((v) => v.finished).length;
    assert.equal(finishedCount, 1);
    assert.deepEqual(sm.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });
  });

  it('allows participants to cancel active sessions and hosts to cancel invites', () => {
    const sm = new SessionManager({ defaultIdleTimeoutMs: 0 });
    const im = new InviteManager({ sessionManager: sm, defaultTtlMs: 0 });
    const gm = new GameManager({ sessionManager: sm, inviteManager: im });
    gm.registerGame('dummy', createDummyEngine());

    gm.createChallenge({ gameType: 'dummy', channelId: 'ch1', hostId: 'p1', opponentId: 'p2' });
    assert.throws(() => gm.cancelByUser('p2'));
    const invCancel = gm.cancelByUser('p1');
    assert.equal(invCancel.type, 'invite');
    assert.equal(im.count, 0);

    gm.createChallenge({ gameType: 'dummy', channelId: 'ch1', hostId: 'p1', opponentId: 'p2' });
    gm.acceptChallenge('p2');
    assert.throws(() => gm.cancelByUser('outsider'));
    const sessCancel = gm.cancelByUser('p2');
    assert.equal(sessCancel.type, 'session');
    assert.deepEqual(sm.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });
  });
});
