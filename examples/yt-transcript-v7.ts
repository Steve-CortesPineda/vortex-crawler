async function main() {
  const videoId = 'dQw4w9WgXcQ';

  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await resp.text();

  const dataMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  if (!dataMatch) { console.log('No data'); return; }

  const data = JSON.parse(dataMatch[1]);
  const panels = data.engagementPanels || [];

  // Find the transcript panel
  for (const panel of panels) {
    const renderer = panel.engagementPanelSectionListRenderer;
    if (renderer?.panelIdentifier === 'engagement-panel-searchable-transcript') {
      console.log('Found transcript panel!');
      const content = renderer.content;
      console.log('Content keys:', Object.keys(content || {}));

      // The transcript body is inside continuationItemRenderer
      // which means it's loaded via continuation (AJAX)
      // Let's check what's there
      const body = content?.continuationItemRenderer;
      if (body) {
        console.log('Has continuation:', !!body.continuationEndpoint);
        const continuation = body.continuationEndpoint?.getTranscriptEndpoint?.params;
        if (continuation) {
          console.log('Continuation params:', continuation);

          // Use InnerTube to get the transcript with these params
          const transcriptResp = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: 'WEB',
                  clientVersion: '2.20250101.00.00',
                  hl: 'en',
                },
              },
              params: continuation,
            }),
          });

          console.log('Transcript API status:', transcriptResp.status);
          const transcriptData = await transcriptResp.json() as any;

          if (transcriptData.actions) {
            // Navigate to the actual transcript segments
            const panelAction = transcriptData.actions[0]?.updateEngagementPanelAction;
            const transcriptBody = panelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer;

            if (transcriptBody) {
              const cueGroups = transcriptBody.cueGroups || [];
              console.log('\nTranscript segments:', cueGroups.length);

              for (const group of cueGroups.slice(0, 15)) {
                const cue = group.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
                if (cue) {
                  const text = cue.cue?.simpleText || cue.cue?.runs?.map((r: any) => r.text).join('') || '';
                  const startMs = parseInt(cue.startOffsetMs || '0');
                  const min = Math.floor(startMs / 60000);
                  const sec = Math.floor((startMs % 60000) / 1000);
                  console.log(`[${min}:${sec.toString().padStart(2, '0')}] ${text}`);
                }
              }
            }
          } else if (transcriptData.error) {
            console.log('Error:', transcriptData.error.message);
          } else {
            console.log('Unknown response:', JSON.stringify(transcriptData).slice(0, 300));
          }
        }
      }
    }
  }
}
main().catch(console.error);
