import test from 'node:test';
import assert from 'node:assert/strict';
import {copyRepositoryName, createToast, repositoryActions} from './interactions.mjs';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
}
const document = {createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag)};
const repository = {id:'lineage:group', name:'owner/current-representative', url:'https://github.com/owner/current-representative', lineage:{members:['owner/old', 'owner/current-representative'], dominantRepositoryId:'owner/old'}};

test('copy waits for clipboard success and uses one full representative name, never all group members', async () => {
  const notices = [], writes = [];
  let resolve;
  const pending = copyRepositoryName(repository, {clipboard:{writeText: name => {writes.push(name); return new Promise(done => {resolve = done;});}}, notify:(...args) => notices.push(args)});
  assert.deepEqual(writes, ['owner/current-representative']);
  assert.deepEqual(notices, []);
  resolve(); assert.equal(await pending, true);
  assert.deepEqual(notices, [['已复制 owner/current-representative']]);
});

test('clipboard rejection and unavailability visibly fail without claiming success', async () => {
  for (const clipboard of [undefined, {writeText: async () => {throw new Error('NotAllowedError');}}]) {
    const notices = [];
    assert.equal(await copyRepositoryName(repository, {clipboard, notify:(...args) => notices.push(args)}), false);
    assert.equal(notices.length, 1);
    assert.match(notices[0][0], /^复制失败：owner\/current-representative/);
    assert.equal(notices[0][1].error, true);
    assert.doesNotMatch(notices[0][0], /已复制/);
  }
});

test('repository copy is a native button and navigation remains a separate labelled link', () => {
  const names = [];
  const actions = repositoryActions(repository, {document, onCopy: item => names.push(item.name)});
  const [button, link] = actions.children;
  assert.equal(button.tagName, 'button'); assert.equal(button.type, 'button');
  assert.equal(button.textContent, 'current-representative');
  assert.equal(button.attributes['aria-label'], '复制完整仓库名称 owner/current-representative');
  assert.equal(button.events.keydown, undefined, 'native buttons provide Enter and Space without duplicate handlers');
  button.events.click(); assert.deepEqual(names, [repository.name]);
  assert.equal(link.tagName, 'a'); assert.equal(link.href, repository.url);
  assert.match(link.attributes['aria-label'], /在 GitHub 打开/);
  assert.equal(link.events.click, undefined, 'navigation must not also copy');
  assert.equal(repositoryActions({...repository, visibility:'private', url:null}, {document, onCopy:()=>{}}).children.length, 1);
  assert.equal(repositoryActions({...repository, url:'javascript:alert(1)'}, {document, onCopy:()=>{}}).children.length, 1);
});

test('toast replaces old expiry and automatically clears without moving focus', () => {
  const node = new Node('div'), jobs = new Map(); let id = 0;
  const notify = createToast(node, {schedule:fn => {jobs.set(++id, fn); return id;}, cancel:key => jobs.delete(key)});
  notify('已复制 one'); assert.equal(node.textContent, '已复制 one'); assert.equal(node.dataset.visible, 'true');
  notify('复制失败 two', {error:true}); assert.equal(jobs.size, 1); assert.equal(node.dataset.error, 'true');
  jobs.values().next().value(); assert.equal(node.dataset.visible, 'false'); assert.equal(node.textContent, '');
});
