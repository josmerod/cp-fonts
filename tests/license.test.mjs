import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLicense } from '../scripts/lib/license.mjs';

const OFL = 'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007';
const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy';

test('a license is named by its text, whatever its file is called', () => {
  assert.equal(classifyLicense('Copyright someone\n\n' + OFL + '\n\nPREAMBLE'), 'OFL');
  assert.equal(classifyLicense('GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991'), 'GPL');
  assert.equal(classifyLicense('APACHE LICENSE\nVersion 2.0, January 2004'), 'Apache-2.0');
  assert.equal(classifyLicense('GUST FONT LICENSE\nThis is version 1.0'), 'GUST');
  assert.equal(classifyLicense('IPA FONT LICENSE\nVersion 1.0'), 'IPA');
  assert.equal(classifyLicense('M+ FONTS LICENSE'), 'M+');
  assert.equal(classifyLicense('Redistribution and use in source and binary forms'), 'BSD');
  assert.equal(classifyLicense(MIT + ' of this software'), 'MIT');
  assert.equal(classifyLicense('CC0 1.0 Universal'), 'CC0/PD');
  assert.equal(classifyLicense('Some terms nobody has seen yet'), null);
  assert.equal(classifyLicense(''), null);
});

test('a licence that quotes a generic one is still its own', () => {
  // The Ubuntu Font Licence opens with the MIT wording.
  assert.equal(classifyLicense('UBUNTU FONT LICENCE Version 1.0\n\n' + MIT + ' of the Font Software'), 'UFL');
});

test('Creative Commons and Design Science licences get their own names', () => {
  assert.equal(classifyLicense('under Licence publique Creative Commons Attribution 4.0 International'), 'CC-BY-4.0');
  assert.equal(classifyLicense('Creative Commons Attribution-ShareAlike 3.0 Unported'), 'CC-BY-SA-3.0');
  assert.equal(classifyLicense('Creative Commons Attribution'), 'CC-BY');
  assert.equal(classifyLicense('DESIGN SCIENCE LICENSE\n\nTERMS AND CONDITIONS FOR COPYING'), 'DSL');
});

test('the OFL is the OFL in French too, and the Bitstream Charter licence is not it', () => {
  // Adelphe ships its licence as a French restatement of the SIL OFL.
  assert.equal(classifyLicense('OIFL - Open Inclusif·ve Fonte Licence\n\nCette fonte est licenciée sous la licence SIL Open Font Licence, Version 1.1'), 'OFL');
  const charter = 'Original Bitstream Free font license:\n\nYou are hereby granted permission under all Bitstream propriety rights '
    + 'to use, copy, modify, sublicense, sell, and redistribute the 4 Bitstream Charter (r) Type 1 outline fonts for any purpose';
  assert.equal(classifyLicense(charter), 'Bitstream');
  // DejaVu cites Bitstream too: what follows is the Vera licence, an MIT-style
  // grant that also requires modified versions to be renamed.
  const vera = 'Fonts are (c) Bitstream (see below). DejaVu changes are in public domain.\nBitstream Vera Fonts Copyright\n' + MIT;
  assert.equal(classifyLicense(vera), 'Bitstream Vera');
  assert.equal(classifyLicense(MIT + ' of the Font Software'), 'MIT', 'without the Vera heading it is the MIT');
  // Hack quotes the Vera licence for what it inherited, under an MIT headline.
  const hack = 'The work in the Hack project is Copyright 2018 Source Foundry Authors and licensed under the MIT License\n'
    + 'Bitstream Vera Sans Mono Copyright 2003 Bitstream Inc. and licensed under the Bitstream Vera License\n'
    + '### MIT License\n' + MIT + '\n### BITSTREAM VERA LICENSE\n' + MIT;
  assert.equal(classifyLicense(hack), 'MIT');
});
