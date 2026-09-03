async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Use the YouTube page itself to find the transcript
  // YouTube embeds transcript data in ytInitialData for some videos
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'SOCS=CAESEwgDEgk2NTcxNjcxNTQaAmVuIAEaBgiA_ZGYBA',
    },
  });
  const html = await resp.text();

  // Check if transcript is embedded in initial data
  const dataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  if (dataMatch) {
    const data = JSON.parse(dataMatch[1]);
    // Look for engagement panels
    const panels = data.engagementPanels || [];
    console.log('Engagement panels:', panels.length);
    for (const panel of panels) {
      const id = panel.engagementPanelSectionListRenderer?.panelIdentifier;
      console.log('  Panel:', id);
    }
  }

  // Alternative: extract from the description for lyrics/manually posted transcripts
  const playerMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (playerMatch) {
    const player = JSON.parse(playerMatch[1]);
    const description = player.videoDetails?.shortDescription || '';

    // Check for auto-generated captions in streaming data
    const streamingData = player.streamingData;
    console.log('\nStreaming formats:', streamingData?.formats?.length || 0);
    console.log('Adaptive formats:', streamingData?.adaptiveFormats?.length || 0);

    // Check microformat for available captions
    const microformat = player.microformat?.playerMicroformatRenderer;
    console.log('Available countries:', microformat?.availableCountries?.length || 0);
    console.log('isFamilySafe:', microformat?.isFamilySafe);

    // The real approach: use the /youtubei/v1/player endpoint
    console.log('\n--- Trying InnerTube player API ---');

    const playerResp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.02.39 (Linux; U; Android 14; en_US)',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.02.39',
            hl: 'en',
          },
        },
      }),
    });

    const playerData = await playerResp.json() as any;
    const androidCaptions = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (androidCaptions) {
      console.log('Android captions:', androidCaptions.length);
      for (const track of androidCaptions.slice(0, 3)) {
        console.log(`  ${track.languageCode}: ${track.baseUrl?.slice(0, 100)}`);
      }

      // Try fetching with Android UA
      const captionUrl = androidCaptions[0].baseUrl;
      const captionResp = await fetch(captionUrl, {
        headers: {
          'User-Agent': 'com.google.android.youtube/19.02.39',
        },
      });
      const captionText = await captionResp.text();
      console.log('\nCaption length:', captionText.length);
      if (captionText.length > 0) {
        console.log('First 500:', captionText.slice(0, 500));

        // Parse
        const lines: string[] = [];
        const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
        let m;
        while ((m = regex.exec(captionText)) !== null) {
          const start = parseFloat(m[1]);
          const t = m[3].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
          const min = Math.floor(start / 60);
          const sec = Math.floor(start % 60);
          lines.push(`[${min}:${sec.toString().padStart(2, '0')}] ${t}`);
        }
        console.log('\nTranscript:', lines.length, 'lines');
        console.log(lines.slice(0, 15).join('\n'));
        console.log('...');
        console.log(lines.slice(-5).join('\n'));
      }
    }
  }
}
main().catch(console.error);
