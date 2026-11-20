// The original stations keep their places even when every remote list is unavailable.
// Broadcaster URLs with expiring signatures are obtained from the configured playlists.
export const fixedLineup = [
  {
    number: 0, name: 'La Voz de María', tvgIds: ['LaVozdeMaria.do'], names: ['La Voz de María TV'],
    streams: [{ url: 'https://live.lavozdemaria.com:3436/live/lavozdemarialive.m3u8' }]
  },
  {
    number: 1, name: 'Jarabacoa TV', tvgIds: ['JARABACOATV.do'], names: ['Jarabacoa Televisión'],
    streams: [{ url: 'https://streaming.jarabacoatv.com/Jarabacoa_tv/playlist.m3u8' }]
  },
  {
    number: 2, name: 'La Voz de Jesús', tvgIds: ['LaVozdeJesusHD.do', 'LaVozdeJesus.do'], names: ['La Voz de Jesús HD'],
    streams: [
      { url: 'https://183.giatvcdn.com/giatvplayout7/giatv-208429/playlist.m3u8' },
      { url: 'https://live20.bozztv.com/giatvplayout7/giatv-208429/playlist.m3u8' }
    ]
  },
  {
    number: 3, name: 'Telever', tvgIds: ['Telever.do'], names: ['Telever TV'],
    streams: [{ url: 'https://soportedvb.click:3413/live/televerlive.m3u8' }]
  },
  {
    number: 4, name: 'Teleantillas', tvgIds: ['TeleAntillas.do'], names: ['Tele Antillas', 'Teleantillas 2', 'Teleantillas 10'], streams: []
  },
  {
    number: 5, name: 'Telesistema 11', tvgIds: ['Telesistema11.do'], names: ['Telesistema', 'Telesistema Canal 11'], streams: []
  },
  {
    number: 6, name: 'Color Visión', tvgIds: ['ColorVision.do'], names: ['Color Visión 9', 'Color Visión Canal 9'], streams: []
  }
];

export const lineupLabels = { fixed: 'Fijo', rd: 'Principal de RD', cable: 'Cable' };
