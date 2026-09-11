const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const date = (year, month, day) => new Date(year, month - 1, day);
const reading = name => ({
    title: { en: 'Parashat Hashavua' }, displayValue: { he: name },
    extraDetails: { aliyot: Array.from({ length: 8 }, (_, i) => `Deuteronomy 32:${i + 1}`) }
});

function harness(responses = []) {
    const requests = [];
    const localStorage = {
        getItem(key) { return this[key] ?? null; },
        setItem(key, value) { this[key] = String(value); },
        removeItem(key) { delete this[key]; }
    };
    const context = vm.createContext({
        console, window: {}, localStorage, document: { addEventListener() {} },
        fetch: async url => {
            requests.push(url);
            const response = responses.shift();
            assert.ok(response, 'Unexpected calendar request');
            return { ok: true, json: async () => response, ...response.http };
        }
    });
    vm.runInContext(script, context);
    vm.runInContext('loadAliyah = () => {}; schedulePrefetch = () => {};', context);
    return { context, requests, localStorage };
}

test('app and service worker syntax', () => {
    new vm.Script(script);
    new vm.Script(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'));
});

test('regular and combined portions are accepted; festivals are rejected', () => {
    const { context } = harness();
    for (const name of ['האזינו', 'בראשית', 'שמיני', 'לך לך', 'ויקהל-פקודי', 'תזריע־מצורע', 'נצבים–וילך']) {
        assert.equal(context.isRegularParsha(reading(name)), true, name);
    }
    for (const name of ['ראש השנה א', 'יום כיפור', 'פסח', 'סוכות חג ראשון', 'שמיני עצרת', 'וזאת הברכה', '', 'ויקהל-']) {
        assert.equal(context.isRegularParsha(reading(name)), false, name);
    }
    for (const item of [null, {}, { title: {} }]) assert.equal(context.isRegularParsha(item), false);
});

test('Rosh Hashana selects Haazinu and saves expiration at its Shabbat', async () => {
    const { context, requests, localStorage } = harness([
        { calendar_items: [reading('ראש השנה א')] }, { calendar_items: [reading('האזינו')] }
    ]);
    const input = date(2026, 9, 11);
    await context.loadCalendar(input);
    assert.equal(input.getTime(), date(2026, 9, 11).getTime());
    assert.equal(requests.length, 2);
    assert.match(requests[1], /year=2026&month=09&day=18$/);
    const saved = JSON.parse(localStorage.getItem('shnayim_state_v1'));
    assert.equal(saved.parshaTitle, 'האזינו');
    assert.equal(saved.aliyotRefs.length, 7);
    assert.equal(saved.expiration, date(2026, 9, 19).getTime());
    assert.equal(saved.weeklyBoundaryVersion, 4);
    context.saveState();
    assert.equal(JSON.parse(localStorage.getItem('shnayim_state_v1')).expiration, saved.expiration);
});

test('skips consecutive holidays and missing weekly entries', async () => {
    const { context, requests } = harness([
        { calendar_items: [reading('סוכות חג ראשון')] },
        { calendar_items: [] }, { calendar_items: [reading('בראשית')] }
    ]);
    const result = await context.findNextRegularParsha(date(2026, 9, 20));
    assert.equal(result.parshaItem.displayValue.he, 'בראשית');
    assert.equal(requests.length, 3);
    assert.match(requests[2], /year=2026&month=10&day=04$/);
    assert.equal(result.expiration, date(2026, 10, 10).getTime());
});

test('normal weeks, Saturday transition, and year rollover', async () => {
    for (const [input, responses, query, expiry] of [
        [date(2026, 3, 8), ['ויקהל-פקודי'], '2026&month=03&day=08', date(2026, 3, 14)],
        [date(2026, 9, 12), ['האזינו'], '2026&month=09&day=13', date(2026, 9, 19)],
        [date(2026, 12, 31), ['פסח', 'שמות'], '2027&month=01&day=07', date(2027, 1, 9)]
    ]) {
        const { context, requests } = harness(responses.map(name => ({ calendar_items: [reading(name)] })));
        const result = await context.findNextRegularParsha(input);
        assert.equal(requests.length, responses.length);
        assert.ok(requests.at(-1).endsWith(query));
        assert.equal(result.expiration, expiry.getTime());
    }
});

test('search is bounded; HTTP failures and invalid responses are not skipped', async () => {
    const { context, requests } = harness(Array.from({ length: 8 }, () => ({ calendar_items: [] })));
    await assert.rejects(context.findNextRegularParsha(date(2026, 9, 11)), /eight weeks/);
    assert.equal(requests.length, 8);
    const incomplete = reading('האזינו');
    incomplete.extraDetails = {};
    for (const [response, error] of [
        [{ http: { ok: false, status: 503 } }, /503/],
        [{ error: 'unavailable' }, /Invalid calendar/],
        [{ calendar_items: [incomplete] }, /Missing parasha aliyot/]
    ]) {
        const h = harness([response]);
        await assert.rejects(h.context.findNextRegularParsha(date(2026, 9, 11)), error);
        assert.equal(h.requests.length, 1);
    }
});

test('cache migration and expiration preserve only current preparation', () => {
    for (const [version, offset, valid] of [[3, 86400000, false], [4, 86400000, true], [4, -1, false]]) {
        const { context, localStorage } = harness();
        localStorage.setItem('shnayim_state_v1', JSON.stringify({
            weeklyBoundaryVersion: version, expiration: Date.now() + offset, parshaTitle: 'האזינו'
        }));
        localStorage.setItem('shnayim_bookmark_v2', 'bookmark');
        assert.equal(context.checkExpiration()?.parshaTitle ?? null, valid ? 'האזינו' : null);
        assert.equal(localStorage.getItem('shnayim_bookmark_v2'), valid ? 'bookmark' : null);
    }
});