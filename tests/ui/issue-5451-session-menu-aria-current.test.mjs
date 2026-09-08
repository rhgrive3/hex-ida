import assert from 'node:assert/strict';
import { menuItemIndex } from '../../js/ai/ui/session-menu.js';

const newChat = { label: 'New chat' };
const first = { label: 'First chat' };
const second = { label: 'Second chat' };
const rename = { label: 'Rename' };
const remove = { label: 'Delete' };
const items = [newChat, '-', first, second, '-', rename, remove];

assert.equal(menuItemIndex(items, first), 1, 'the first conversation follows the separator, not two raw entries');
assert.equal(menuItemIndex(items, second), 2, 'conversation indexes remain contiguous across separators');
assert.equal(menuItemIndex(items, rename), 3, 'post-conversation actions keep their rendered menuitem index');
assert.equal(menuItemIndex(items, remove), 4);
assert.equal(menuItemIndex(items, { label: 'missing' }), -1, 'unknown items cannot receive aria-current');
assert.equal(menuItemIndex(items, null), -1);

console.log('issue-5451-session-menu-aria-current: PASS');
