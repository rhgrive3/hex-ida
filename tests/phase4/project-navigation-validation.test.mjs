import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHexProject,
  ProjectFormatError,
  validateHexProject,
} from '../../js/project/index.js';

const EMPTY_NAVIGATION = {
  currentFunction: null,
  history: [],
  cursorIndex: null,
  bookmarks: [],
  lastQuery: null,
};

function persistedProject(navigation, includeNavigation = true) {
  const project = {
    format: 'hexproj',
    version: 2,
    binary: { hash: null, metadata: null, embedded: false },
  };
  if (includeNavigation) project.navigation = navigation;
  return project;
}

function assertNavigationTypeError(fn, label) {
  assert.throws(fn, (error) => (
    error instanceof ProjectFormatError
      && error.message === 'navigation must be an object'
  ), label);
}

test('#3553 create boundary rejects explicit falsy non-objects and arrays', () => {
  for (const navigation of [false, 0, '', []]) {
    assertNavigationTypeError(
      () => createHexProject({ navigation }),
      `createHexProject must reject ${JSON.stringify(navigation)}`,
    );
  }
});

test('#3553 persisted-project normalization rejects explicit falsy non-objects and arrays', () => {
  for (const navigation of [false, 0, '', []]) {
    assertNavigationTypeError(
      () => validateHexProject(persistedProject(navigation)),
      `validateHexProject must reject ${JSON.stringify(navigation)}`,
    );
  }
});

test('#3553 nullish navigation keeps the existing empty-navigation default', () => {
  assert.deepEqual(createHexProject({ navigation: null }).navigation, EMPTY_NAVIGATION);
  assert.deepEqual(createHexProject({}).navigation, EMPTY_NAVIGATION);
  assert.deepEqual(validateHexProject(persistedProject(null)).navigation, EMPTY_NAVIGATION);
  assert.deepEqual(validateHexProject(persistedProject(undefined, false)).navigation, EMPTY_NAVIGATION);
});

test('#3553 valid navigation objects preserve their normalized meaning', () => {
  const navigation = {
    currentFunction: 'fn:1',
    history: ['fn:0', 'fn:1'],
    cursorIndex: 1,
    bookmarks: ['fn:1'],
    lastQuery: 'calls to fn:1',
  };
  assert.deepEqual(createHexProject({ navigation }).navigation, navigation);
  assert.deepEqual(validateHexProject(persistedProject(navigation)).navigation, navigation);
});
