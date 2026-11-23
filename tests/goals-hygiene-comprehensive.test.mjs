import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOALS,
  expandTerms,
  extractCallableLeaf,
  fieldRole,
  goalFromPreset,
  matchField,
  matchText,
  numericSymbolRole,
  parseGoal,
  typeFits,
} from '../js/goals.js';

const expandedWords = (text) => expandTerms(text).map((t) => t.word);

test('SYNONYMS word boundaries prevent substring false positives while keeping valid words', () => {
  // ads: \bads?\b
  for (const benign of ['download', 'reload', 'thread', 'threads', 'breadcrumb', 'payload']) {
    assert.ok(!expandedWords(benign).includes('interstitial'), `"${benign}" must not expand to ads`);
  }
  assert.ok(expandedWords('ad').includes('interstitial'));
  assert.ok(expandedWords('ads').includes('interstitial'));
  assert.ok(expandedWords('広告').includes('interstitial'));

  // gems: \bgems?\b
  for (const benign of ['management', 'arrangement', 'judgement']) {
    assert.ok(!expandedWords(benign).includes('jewel'), `"${benign}" must not expand to gems`);
  }
  assert.ok(expandedWords('gem').includes('jewel'));
  assert.ok(expandedWords('gems').includes('jewel'));

  // exp: \bexp\b
  for (const benign of ['export', 'expect', 'expression', 'expire', 'explicit']) {
    assert.ok(!expandedWords(benign).includes('experience'), `"${benign}" must not expand to exp`);
  }
  assert.ok(expandedWords('exp').includes('experience'));

  // hp: \bhp\b
  for (const benign of ['php', 'dhcp', 'xpath', 'mph']) {
    assert.ok(!expandedWords(benign).includes('health'), `"${benign}" must not expand to hp`);
  }
  assert.ok(expandedWords('hp').includes('health'));

  // api: \bapi\b
  for (const benign of ['rapid', 'capital', 'capability', 'therapy']) {
    assert.ok(!expandedWords(benign).includes('http'), `"${benign}" must not expand to api`);
  }
  assert.ok(expandedWords('api').includes('http'));

  // counts: \bcounts?\b
  for (const benign of ['account', 'country', 'discount', 'encounter']) {
    assert.ok(!expandedWords(benign).includes('times'), `"${benign}" must not expand to count`);
  }
  assert.ok(expandedWords('count').includes('times'));
  assert.ok(expandedWords('counts').includes('times'));

  // rates: \brates?\b
  for (const benign of ['generate', 'iterate', 'operate', 'separate', 'accurate', 'strategy']) {
    assert.ok(!expandedWords(benign).includes('probability'), `"${benign}" must not expand to rate`);
  }
  assert.ok(expandedWords('rate').includes('probability'));
  assert.ok(expandedWords('rates').includes('probability'));

  // auth: \bauth(?:enticat\w*|oriz\w*|n|z)?\b
  for (const benign of ['author', 'authors', 'authority', 'authoritative', 'authorship']) {
    assert.ok(!expandedWords(benign).includes('login'), `"${benign}" must not expand to auth/login`);
  }
  for (const valid of ['auth', 'authn', 'authz', 'authenticate', 'authentication', 'authorize', 'authorization']) {
    assert.ok(expandedWords(valid).includes('login'), `"${valid}" should expand to auth/login`);
  }

  // coins: \bcoins?\b
  for (const benign of ['coincide', 'coincident', 'coincidence']) {
    assert.ok(!expandedWords(benign).includes('wallet'), `"${benign}" must not expand to coins`);
  }
  assert.ok(expandedWords('coin').includes('wallet'));
  assert.ok(expandedWords('coins').includes('wallet'));

  // atk: \batk\b
  assert.ok(!expandedWords('catk').includes('attack'));
  assert.ok(expandedWords('atk').includes('attack'));

  // Single-char kanji 石 / 金 tightened to compound words
  for (const benign of ['金曜日', '金属', '料金', '石川', '磁石']) {
    assert.ok(!expandedWords(benign).includes('wallet'), `"${benign}" must not expand to money`);
    assert.ok(!expandedWords(benign).includes('jewel'), `"${benign}" must not expand to gems`);
  }
  for (const moneyJa of ['所持金', 'お金', '資金', '通貨']) {
    assert.ok(expandedWords(moneyJa).includes('wallet'), `"${moneyJa}" should expand to money`);
  }
  for (const gemJa of ['課金石', '魔法石', '魔晶石', '聖晶石', '有償石', '無償石', 'ガチャ石']) {
    assert.ok(expandedWords(gemJa).includes('jewel'), `"${gemJa}" should expand to gems`);
  }
});

test('GOALS strong/weak remain /i-safe and preserve CamelCase/snake_case matching', () => {
  // No uppercase-transition lookahead/lookbehind in strong/weak
  for (const g of GOALS) {
    for (const re of [...g.strong, ...g.weak]) {
      assert.ok(!/\(\?[<=!].*\[A-Z\]/.test(re.source), `${g.id} regex ${re} must not rely on case-sensitive uppercase lookaround`);
    }
  }
  assert.ok(matchText(goalFromPreset('money'), '-[Player coinCount]'));
  assert.ok(matchText(goalFromPreset('money'), 'coin_count'));
  assert.ok(matchText(goalFromPreset('money'), 'manaCost'));
  assert.ok(matchText(goalFromPreset('item'), 'itemCount'));
  assert.ok(matchText(goalFromPreset('score'), 'skillPoint'));
  assert.ok(matchText(goalFromPreset('attack'), 'heroPower'));
  assert.ok(matchText(goalFromPreset('level'), 'playerRank'));
  assert.ok(matchText(goalFromPreset('gacha'), 'rareItem'));
});

test('Per-preset avoid rules block known false positives while keeping real matches', () => {
  const cases = [
    {
      id: 'damage',
      blocked: ['white', 'whitelist', 'whitespace', 'offwhite', 'hitch', 'matchIterator', 'cacheHit', 'cache_hit', 'hitSlop', 'criticalSection', 'criticalError', 'criticalLog', 'criticalAlert', 'criticalFailure', 'criticalLevel'],
      allowed: ['takeDamage', 'criticalHit', 'hitEnemy', 'whiteDamage'],
    },
    {
      id: 'gacha',
      blocked: ['generate', 'generated', 'generator', 'iterate', 'iterator', 'operate', 'operator', 'separate', 'accelerate', 'migrate', 'integrate', 'accurate', 'strategy', 'infrared', 'rarely', 'frameRate', 'sample_rate', 'bitRate', 'refreshRate', 'baudRate', 'heartRate', 'tickRate', 'errorRate', 'hitRate', 'missRate', 'drawCall', 'drawRect', 'drawInRect', 'drawMesh', 'drawSprite', 'drawText', 'drawImage', 'drawLine', 'drawPath', 'drawLayer', 'drawBuffer', 'drawPass', 'drawOrder', 'drawMode', 'drawIndexed', 'drawArray', 'drawElement', 'drawPrimitive', 'drawVertex', 'drawQuad', 'drawTriangle', 'drawCanvas', 'drawContext', 'drawSurface', 'drawTexture', 'drawShadow', 'drawView', 'drawNode', 'drawGizmo', 'drawBatch'],
      allowed: ['gachaRate', 'summonHero', 'drawGacha', 'rareItem', 'dropRate'],
    },
    {
      id: 'money',
      blocked: ['costume', 'acoustic', 'coincide', 'coincident', 'multiconcurrency', 'whiteBalance', 'loadBalance', 'audioBalance', 'stereoBalance', 'colorBalance', 'channelBalance'],
      allowed: ['coinCount', 'playerGold', 'walletBalance', 'manaCost'],
    },
    {
      id: 'score',
      blocked: ['pointer', 'nullptr', 'endpoint', 'breakpoint', 'checkpoint', 'entrypoint', 'floatingPoint', 'codePoint', 'midpoint', 'appoint', 'CGPoint', 'focalPoint', 'touchPoint', 'audioRecord', 'videoRecord', 'voiceRecord', 'screenRecord', 'dnsRecord'],
      allowed: ['highScore', 'playerScore', 'skillPoint', 'gameRecord'],
    },
    {
      id: 'item',
      blocked: ['account', 'country', 'discount', 'encounter', 'menuItem', 'tabBarItem', 'barButtonItem', 'navigationItem', 'navItem', 'toolbarItem', 'listItem', 'collectionViewItem', 'statusItem', 'accessibilityItem', 'materialDesign', 'materialShader', 'materialTexture', 'materialPbr', 'materialDiffuse', 'materialSpecular', 'materialAlbedo', 'materialMetallic', 'materialRoughness'],
      allowed: ['inventory', 'itemCount', 'playerItems', 'craftMaterial'],
    },
    {
      id: 'save',
      blocked: ['restore', 'StoreKit', 'AppStore', 'PlayStore', 'storefront', 'powerSaving', 'batterySave', 'energySaving', 'saveGState', 'saveGraphics', 'saveContext', 'saveMatrix', 'saveTransform'],
      allowed: ['saveData', 'saveFile', 'autoSave', 'userDefaults', 'persistProgress'],
    },
    {
      id: 'login',
      blocked: ['author', 'authors', 'authored', 'authoring', 'authorship', 'authoritative', 'tokenizerToken', 'lexerToken', 'parserToken', 'syntaxToken', 'jsonToken', 'xmlToken', 'astToken', 'tokenizer', 'tokenize', 'tokenType', 'tokenKind', 'tokenStream', 'NSURLSession', 'AVAudioSession', 'AVCaptureSession', 'ARSession', 'VRSession', 'WCSession', 'mediaSession', 'playbackSession'],
      allowed: ['loginUser', 'authToken', 'accessToken', 'userSession', 'clearSession'],
    },
    {
      id: 'level',
      blocked: ['crank', 'frank', 'prank', 'drank', 'shrank', 'batteryLevel', 'zoomLevel', 'compressionLevel', 'mipLevel', 'mipmapLevel', 'windowLevel', 'apiLevel', 'featureLevel', 'debugLevel', 'errorLevel', 'warningLevel', 'traceLevel', 'severityLevel', 'nestingLevel', 'indentLevel'],
      allowed: ['playerLevel', 'levelUp', 'playerRank', 'experience'],
    },
    {
      id: 'hp',
      blocked: ['batteryHealth', 'batteryLife', 'halfLife', 'shelfLife', 'healthStore', 'healthData', 'healthProbe', 'healthEndpoint'],
      allowed: ['playerHealth', 'currentHP', 'playerLife', 'hp_uid', 'hp_texture'],
    },
    {
      id: 'attack',
      blocked: ['powerOf2', 'powerOfTwo', 'powerOf10', 'powerOfTen', 'powerConsumption', 'powerUsage', 'powerBudget', 'powerButton', 'powerKey', 'powerOff', 'powerOn', 'powerThermal', 'signalStrength', 'wifiStrength', 'passwordStrength', 'encryptionStrength', 'blurStrength', 'shadowStrength', 'strlen', 'str_size', 'c_str_len', 'cStrBuf', 'nameStrPtr', 'strCpy', 'strCmp'],
      allowed: ['attackPower', 'heroPower', 'heroStrength', 'baseAtk', 'heroStr'],
    },
    {
      id: 'defense',
      blocked: ['scopeGuard', 'raiiGuard', 'unlockGuard', 'lockGuard', 'driverShield', 'bodyDef', 'fixtureDef', 'shapeDef', 'typedef', 'completionBlock', 'callbackBlock', 'handlerBlock', 'memoryBlock', 'codeBlock', 'cipherBlock', 'blockSize', 'blockCount', 'blockIndex', 'blockOffset', 'irresistible'],
      allowed: ['defenseValue', 'armorRating', 'fireResist', 'playerShield', 'guardRate'],
    },
    {
      id: 'purchase',
      blocked: ['CATransaction', 'sqlTransaction', 'sqliteTransaction', 'dbTransaction', 'databaseTransaction', 'realmTransaction', 'coreDataTransaction', 'beginTransaction', 'commitTransaction', 'rollbackTransaction', 'writeTransaction', 'readTransaction', 'restoreGState', 'restoreState', 'restoreContext', 'restoreWindow', 'restoreView', 'restoreFrame', 'restoreLayout', 'restoreFocus', 'restoreGraphics', 'restoreMatrix', 'restoreTransform'],
      allowed: ['inAppPurchase', 'restorePurchases', 'paymentTransaction', 'storeKitReceipt'],
    },
    {
      id: 'ads',
      blocked: ['adHoc', 'ad_hoc', 'ad-hoc', 'ad hoc'],
      allowed: ['rewardedAd', 'admobBanner', 'interstitial'],
    },
    {
      id: 'network',
      blocked: ['requestAnimationFrame', 'requestLayout', 'requestFocus', 'requestRedraw', 'requestRender', 'requestReview', 'requestPermission', 'tableHeader', 'sectionHeader', 'fileHeader', 'machHeader', 'elfHeader', 'zipHeader', 'pngHeader', 'wavHeader', 'AVAudioSession', 'AVCaptureSession', 'ARSession', 'VRSession', 'WCSession', 'mediaSession'],
      allowed: ['NSURLSession', 'httpRequest', 'httpHeader', 'apiEndpoint'],
    },
    {
      id: 'stamina',
      blocked: ['lowEnergy', 'energyImpact', 'energyUsage', 'energySaving', 'energyEfficiency', 'energyConsumption', 'energyMode', 'energyBudget', 'energyState'],
      allowed: ['playerStamina', 'playerEnergy', 'recoverStamina'],
    },
    {
      id: 'anticheat',
      blocked: ['isSecureTextEntry', 'NSSecureCoding', 'secureEnclave', 'secureConnection', 'secureSocket', 'secureTransport', 'secureCookie', 'secureChannel', 'methodSignature', 'typeSignature', 'functionSignature', 'selectorSignature', 'blockSignature'],
      allowed: ['isJailbroken', 'fridaDetect', 'codeSignature', 'verifyIntegrity'],
    },
  ];

  for (const { id, blocked, allowed } of cases) {
    const goal = goalFromPreset(id);
    for (const s of blocked) {
      assert.equal(matchText(goal, s), null, `${id} matchText must avoid "${s}"`);
      assert.equal(matchField(goal, s), null, `${id} matchField must avoid "${s}"`);
      assert.notEqual(parseGoal(s).id, id, `${id} parseGoal must not select preset for "${s}"`);
    }
    for (const s of allowed) {
      assert.ok(matchText(goal, s) || matchField(goal, s), `${id} should still match "${s}"`);
    }
  }
});

test('userDefault is protected from ROLE_RULES base penalty', () => {
  assert.equal(fieldRole('_userDefault'), 'plain');
  assert.equal(fieldRole('user_default'), 'plain');
  assert.equal(fieldRole('standardUserDefault'), 'plain');
  assert.equal(fieldRole('NSUserDefault'), 'plain');
  assert.equal(fieldRole('defaultHp'), 'base');
  assert.equal(fieldRole('defaultUserDefault'), 'base');

  const save = goalFromPreset('save');
  const hit = matchField(save, '_userDefault');
  assert.ok(hit);
  assert.equal(hit.role, 'plain');
  assert.equal(hit.score, 1);
});

test('typeFits preserves numeric bool contract and rejects non-bool pointer/ref kinds for bool goals', () => {
  const hp = goalFromPreset('hp');
  assert.equal(typeFits(hp, { kind: 'int', bytes: 1, bool: true }), 'conflict');
  assert.equal(typeFits(hp, { kind: 'int', bytes: 4 }), 'fit');

  const ac = goalFromPreset('anticheat');
  assert.equal(typeFits(ac, { kind: 'bool', bytes: 1 }), 'fit');
  assert.equal(typeFits(ac, { kind: 'int', bytes: 1 }), 'fit');
  for (const kind of ['object', 'float', 'cstring', 'class', 'selector', 'block', 'pointer']) {
    assert.equal(typeFits(ac, { kind, bytes: 8 }), 'conflict', `bool goal must reject kind="${kind}"`);
  }
  assert.equal(typeFits(ac, { kind: 'int', bytes: 4 }), 'unknown');
});

test('extractCallableLeaf skips Itanium ref-qualifiers, ABI tags, nested templates, and flags parts[0]==="std"', () => {
  assert.deepEqual(extractCallableLeaf('_ZNR6Player5getHpEv'), {
    leaf: 'getHp', owner: 'Player', isConst: false, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZNKO6Player5getHpEv'), {
    leaf: 'getHp', owner: 'Player', isConst: true, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZN6PlayerB5cxx115getHpB4tag1Ev'), {
    leaf: 'getHp', owner: 'Player', isConst: false, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZN3FooI3BarIiEE5getHpEv'), {
    leaf: 'getHp', owner: 'Foo', isConst: false, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZN3FooI5EnemyE5getHpEv'), {
    leaf: 'getHp', owner: 'Foo', isConst: false, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZN5ArrayIiLi10EE4sizeEv'), {
    leaf: 'size', owner: 'Array', isConst: false, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZN3FooIN3Bar3BazEE5getHpIiEEiv'), {
    leaf: 'getHp', owner: 'Foo', isConst: false, isCtorOrDtor: false, isStdGlue: false,
  });
  assert.deepEqual(extractCallableLeaf('_ZN3std3__16vectorIiNS0_9allocatorIiEEE4sizeEv'), {
    leaf: 'size', owner: 'vector', isConst: false, isCtorOrDtor: false, isStdGlue: true,
  });
  // Unclosed template args must fail safely without throwing
  const malformed = extractCallableLeaf('_ZN3FooI3Bar');
  assert.equal(malformed.leaf, 'Foo');
  assert.equal(malformed.isStdGlue, false);
});

test('numericSymbolRole blocks non-value owner exact-core boost and allows gacha draw', () => {
  const hp = goalFromPreset('hp');
  assert.equal(numericSymbolRole(hp, '-[HpPanel getHp]'), 'non-value');
  assert.equal(numericSymbolRole(hp, '-[HpTooltip hp]'), 'non-value');
  assert.equal(numericSymbolRole(hp, '_ZN12HpController5getHpEv'), 'non-value');
  assert.equal(numericSymbolRole(hp, '-[Player getHp]'), 'value');
  assert.equal(numericSymbolRole(hp, '-[Player drawHp]'), 'non-value');

  // std:: prefix via parts[0] === 'std' is also non-value
  assert.equal(numericSymbolRole(hp, '_ZN3std3__16vectorIiNS0_9allocatorIiEEE2hpEv'), 'non-value');

  // gacha draw is exempt from isPredicateHead
  const gacha = goalFromPreset('gacha');
  assert.equal(numericSymbolRole(gacha, '-[GachaManager draw]'), 'value');
  assert.equal(numericSymbolRole(gacha, '-[GachaManager drawGacha]'), 'value');
  assert.equal(numericSymbolRole(gacha, '-[MyView drawRect:]'), 'neutral');
});
