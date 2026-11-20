import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalog, isCableChannel, isImportantDR, lineupRank, orderedChannels } from '../js/catalog.js';
import { fixedLineup } from '../js/lineup.js';

const options = { fixedLineup };
const reserved = [
  'La Voz de María', 'Jarabacoa TV', 'La Voz de Jesús', 'Telever', 'Teleantillas', 'Telesistema 11', 'Color Visión'
];

function station(name, tvgId, sourceId = 'demo') {
  return { name, tvgId, sourceId, url: `https://demo.example/${tvgId}/index.m3u8` };
}

test('reserves the original numbers even without sources and ignores old hide or ordering for fixed stations', () => {
  const lookupOnly = { fixedLineup: fixedLineup.map(item => ({ ...item, streams: [] })) };
  const channels = buildCatalog([], {}, lookupOnly);
  const fixed = orderedChannels(channels, {
    order: [...channels].reverse().map(channel => channel.id),
    hidden: channels.map(channel => channel.id)
  });
  assert.deepEqual(fixed.map(channel => channel.name), reserved);
  assert.deepEqual(fixed.map(channel => channel.number), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(fixed.every(channel => channel.fixed && channel.lineupGroup === 'fixed' && channel.streams.length === 0));
});

test('links authorized-list variants to a fixed station without confusing an identically named foreign channel', () => {
  const maria = station('La Voz de Maria (1080p)', 'LaVozDeMaria.do@Principal');
  const telesistema = { ...station('Telesistema Canal 11', 'OtherFeed.do'), countries: ['DO'] };
  const colour = station('Color Visión', 'ColorVision.gt');
  const lookupOnly = { fixedLineup: fixedLineup.map(item => ({ ...item, streams: [] })) };
  const channels = buildCatalog([maria, telesistema, colour], {}, lookupOnly);
  assert.equal(channels.length, 8);
  assert.equal(channels[0].id, 'fixed:0');
  assert.equal(channels[0].streams[0].url, maria.url);
  assert.equal(channels[0].streams[0].sourceId, maria.sourceId);
  assert.ok(channels[0].tvgIds.includes(maria.tvgId));
  assert.equal(channels[5].streams[0].url, telesistema.url);
  assert.equal(channels[6].streams.length, 0);
  assert.equal(channels[7].country, 'GT');
  assert.equal(channels[7].streams[0].url, colour.url);
});

test('keeps official viewing pages separate from streams and ignores navigation metadata from playlists', () => {
  const fakePage = 'https://demo.example/pretend-official';
  const incoming = { ...station('Telesistema 11', 'Telesistema11.do'), officialPage: fakePage };
  const external = { ...station('Otro canal', 'OtroChannel.do'), officialPage: fakePage };
  const channels = buildCatalog([incoming, external], {}, options);
  const telesistema = channels.find(channel => channel.number === 5);
  const colour = channels.find(channel => channel.number === 6);
  assert.equal(telesistema.officialPage, 'https://telesistema11.com.do/en-vivo/');
  assert.equal(colour.officialPage, 'https://colorvision.com.do/en-vivo/');
  assert.deepEqual(telesistema.streams.map(stream => stream.url), [incoming.url]);
  assert.equal(channels.find(channel => channel.name === external.name).officialPage, undefined);
  const invalid = buildCatalog([], {}, { fixedLineup: [{ number: 5, name: 'Prueba', officialPage: 'javascript:alert(1)' }] });
  assert.equal(invalid[0].officialPage, '');
});

test('migrates unrelated occupied slots once and keeps active, disappearing, and returning historical identities', () => {
  let numbers = {
    'tvg:publico.do': 0,
    'name:DO:publico': 0,
    'tvg:guardado.es': 3,
    'tvg:telemicro.do': 7,
    'tvg:distinto.es': 18,
    'tvg:lavozdemaria.do': 38,
    'url:historical-maria-alias': 38
  };
  const publicChannel = station('Público', 'Publico.do');
  const absentChannel = station('Guardado', 'Guardado.es');
  const national = station('Telemicro', 'Telemicro.do');
  const international = station('Distinto', 'Distinto.es');
  const addedMaria = station('Voz de Maria', 'LaVozdeMaria.do');
  const first = buildCatalog([publicChannel, national, international, addedMaria], numbers, options);
  const expectedPublic = first.find(channel => channel.name === 'Público');
  assert.ok(expectedPublic.number > 6);
  assert.equal(first.find(channel => channel.name === 'Telemicro').number, 7);
  assert.equal(first.find(channel => channel.name === 'Distinto').number, 18);
  assert.equal(numbers['tvg:lavozdemaria.do'], 0);
  assert.ok(first[0].aliases.includes('url:historical-maria-alias'));
  const previouslyAbsent = numbers['tvg:guardado.es'];
  assert.ok(previouslyAbsent > 6);
  assert.notEqual(previouslyAbsent, expectedPublic.number);
  numbers = JSON.parse(JSON.stringify(numbers));
  const second = buildCatalog([absentChannel, international, national, publicChannel], numbers, options);
  assert.equal(second[0].number, 0);
  assert.ok(second[0].aliases.includes('url:historical-maria-alias'));
  assert.equal(second.find(channel => channel.id === expectedPublic.id).number, expectedPublic.number);
  assert.equal(second.find(channel => channel.name === 'Guardado').number, previouslyAbsent);
  assert.equal(new Set(second.map(channel => channel.id)).size, second.length);
  assert.equal(new Set(second.map(channel => channel.number)).size, second.length);
});

test('prioritizes nationally identified RD stations, Disney and cable before other DR and foreign stations', () => {
  const entries = [
    station('Cultura extranjera', 'Cultura.es'), station('Calidad Dominicana', 'Calidad.do'),
    station('Imagen Universal TV', 'ImagenUniversalTV.do'), station('FOX 5', 'Fox5.us'),
    station('Sony Channel (720p)', 'SonyChannelLatinAmerica.us'),
    station('Warner Channel', 'WarnerChannel.us@Colombia'),
    station('Cartoon Network', 'CartoonNetworkLatinAmerica.us'),
    station('Disney Channel', 'DisneyChannelLatinAmerica.ar@PanregionalHD'),
    station('CDN 37', 'CDN.do'), station('Telemicro', 'Telemicro.do'),
    station('Canal 4', 'Canal4.cr'), station('RTVD', 'Canal4RD.do')
  ];
  const channels = buildCatalog(entries, {}, options);
  const ordered = orderedChannels(channels);
  assert.deepEqual(ordered.slice(7, 14).map(channel => channel.name), [
    'Telemicro', 'RTVD', 'CDN 37', 'Disney Channel', 'Warner Channel', 'Cartoon Network', 'Sony Channel (720p)'
  ]);
  assert.deepEqual(ordered.slice(7).map(lineupRank), [1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 4]);
  const byName = name => channels.find(channel => channel.name === name);
  const manual = orderedChannels(channels, { order: [byName('Cultura extranjera').id, byName('Cartoon Network').id] });
  assert.equal(manual[10].name, 'Cartoon Network');
  assert.equal(manual[7].name, 'Telemicro');
  assert.equal(manual[16].name, 'Cultura extranjera');
  assert.equal(isImportantDR(byName('Canal 4')), false);
  assert.equal(isCableChannel(byName('Imagen Universal TV')), false);
  assert.equal(isCableChannel(byName('FOX 5')), false);
  assert.equal(isCableChannel({ name: 'Entretenimiento bonito', categories: ['Entertainment'] }), false);
  assert.equal(isCableChannel({ name: 'Otro canal', categories: ['TV de pago'] }), true);
});
