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
        console, window: {}, localStorage, setTimeout, clearTimeout, Intl,
        document: { addEventListener() {}, getElementById: () => ({}) },
        fetch: async url => {
            requests.push(url);
            const response = responses.shift();
            assert.ok(response, 'Unexpected request');
            return { ok: true, json: async () => response, ...response.http };
        }
    });
    vm.runInContext(script, context);
    vm.runInContext('loadAliyah = () => {}; prefetchRemainingAliyot = () => {};', context);
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
    assert.equal(saved.weeklyBoundaryVersion, 5);
    context.saveState();
    assert.equal(JSON.parse(localStorage.getItem('shnayim_state_v1')).expiration, saved.expiration);
});

test('skips consecutive holidays and missing weekly entries', async () => {
    const { context, requests } = harness([
        { calendar_items: [reading('סוכות חג ראשון')] },
        { calendar_items: [] }, { calendar_items: [reading('נח')] }
    ]);
    const result = await context.findNextRegularParsha(date(2026, 10, 4));
    assert.equal(result.parshaItem.displayValue.he, 'נח');
    assert.equal(requests.length, 3);
    assert.match(requests[2], /year=2026&month=10&day=18$/);
    assert.equal(result.expiration, date(2026, 10, 24).getTime());
});

test('Vezot Haberacha is chosen locally until Simchat Torah', async () => {
    const V = 'וזאת הברכה';
    for (const [input, responses, name, expiry] of [
        [date(2026, 9, 19), [], V, date(2026, 10, 3)],
        [date(2026, 9, 20), [], V, date(2026, 10, 3)],
        [date(2026, 10, 2), [], V, date(2026, 10, 3)],
        [date(2026, 10, 3), ['בראשית'], 'בראשית', date(2026, 10, 10)],
        [date(2025, 9, 28), ['האזינו'], 'האזינו', date(2025, 10, 4)],
        [date(2025, 10, 5), [], V, date(2025, 10, 14)],
        [date(2025, 10, 13), [], V, date(2025, 10, 14)],
        [date(2025, 10, 14), ['בראשית'], 'בראשית', date(2025, 10, 18)],
        [date(2028, 9, 22), ['האזינו'], 'האזינו', date(2028, 9, 23)],
        [date(2028, 9, 24), [], V, date(2028, 10, 12)]
    ]) {
        const { context, requests } = harness(responses.map(n => ({ calendar_items: [reading(n)] })));
        const result = await context.findNextRegularParsha(input);
        assert.equal(result.parshaItem.displayValue.he, name, input.toDateString());
        assert.equal(result.expiration, expiry.getTime(), input.toDateString());
        assert.equal(requests.length, responses.length, input.toDateString());
        if (name === V) assert.equal(result.parshaItem.extraDetails.aliyot.length, 7);
    }
});

test('consecutive aliyot are fetched as one range and cached separately', async () => {
    const text = t => ({ indexTitle: 'Deuteronomy', sections: ['33', '28'], versions: [{ language: 'he', isPrimary: true, text: t }] });
    const { context, requests } = harness([
        text([['a', 'b{פ}'], ['c', 'd']]), text([['ta', 'tb'], ['tc', 'td']])
    ]);
    vm.runInContext('state.expiration = Date.now() + 86400000;', context);
    const [first, second] = await context.fetchAliyot(['Deuteronomy 33:28-33:29', 'Deuteronomy 34:1-34:2'], 'low');
    assert.equal(requests.length, 2);
    assert.match(requests[0], /Deuteronomy%2033%3A28-34%3A2\?/);
    assert.match(requests[1], /Onkelos%20Deuteronomy%2033%3A28-34%3A2\?/);
    const plain = v => JSON.parse(JSON.stringify(v));
    assert.deepEqual(plain(first.map(r => [r.p, r.n, r.h, r.o, r.pe, r.newP])), [[33, 28, 'a', 'ta', false, false], [33, 29, 'b', 'tb', true, false]]);
    assert.deepEqual(plain(second.map(r => [r.p, r.n, r.newP])), [[34, 1, true], [34, 2, false]]);
    assert.equal(vm.runInContext("PersistentCache.get('Deuteronomy 34:1-34:2').length", context), 2);
    assert.equal(vm.runInContext("state.verseCounts['Deuteronomy 33:28-33:29']", context), 2);
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
    for (const [version, offset, valid] of [[4, 86400000, false], [5, 86400000, true], [5, -1, false]]) {
        const { context, localStorage } = harness();
        localStorage.setItem('shnayim_state_v1', JSON.stringify({
            weeklyBoundaryVersion: version, expiration: Date.now() + offset, parshaTitle: 'האזינו'
        }));
        localStorage.setItem('shnayim_bookmark_v2', 'bookmark');
        assert.equal(context.checkExpiration()?.parshaTitle ?? null, valid ? 'האזינו' : null);
        assert.equal(localStorage.getItem('shnayim_bookmark_v2'), valid ? 'bookmark' : null);
    }
});