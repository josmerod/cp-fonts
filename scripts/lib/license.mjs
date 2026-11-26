// Classify a license file by its content — the file is the source of truth,
// the filename is not (WP-Fonts ships OFL text under several names). The
// licences of their own come first: their texts quote the generic ones (the
// Ubuntu Font Licence opens with the MIT wording).
const SIGNATURES = [
  // LICENCE: the French restatement Adelphe ships.
  [/SIL OPEN FONT LICEN[CS]E/i, 'OFL'],
  [/GUST FONT LICEN[CS]E/i, 'GUST'],
  [/IPA FONT LICEN[CS]E/i, 'IPA'],
  [/M\+ FONTS? LICEN[CS]E/i, 'M+'],
  [/UBUNTU FONT LICEN[CS]E/i, 'UFL'],
  [/DESIGN SCIENCE LICENSE/i, 'DSL'],
  // XCharter's: permissive, but not the OFL (DejaVu cites Bitstream too).
  [/BITSTREAM CHARTER/i, 'Bitstream'],
  [/GNU GENERAL PUBLIC LICENSE/i, 'GPL'],
  [/APACHE LICENSE/i, 'Apache-2.0'],
  [/REDISTRIBUTION AND USE IN SOURCE/i, 'BSD'],
  // DejaVu's: the Vera licence (the MIT wording plus a naming clause), its own
  // changes public domain. Hack cites the Vera licence too, as an ancestor's,
  // under a headline of its own (the MIT).
  [/DejaVu changes are in public domain/i, 'Bitstream Vera'],
  [/(MIT LICEN[CS]E|Permission is hereby granted, free of charge)/i, 'MIT'],
  [/CC0|PUBLIC DOMAIN/i, 'CC0/PD'],
];

// The short name a catalog lists, or null for a text none of this knows.
export function classifyLicense(text) {
  if (!text) return null;
  // "Creative Commons Attribution 4.0": the version is part of the name.
  const cc = text.match(/CREATIVE COMMONS ATTRIBUTION(-| ?SHAREALIKE)?[^\n]*?(\d\.\d)/i);
  if (cc) return `CC-BY${cc[1] ? '-SA' : ''}-${cc[2]}`;
  if (/CREATIVE COMMONS ATTRIBUTION/i.test(text)) return 'CC-BY';
  for (const [re, name] of SIGNATURES) if (re.test(text)) return name;
  return null;
}
