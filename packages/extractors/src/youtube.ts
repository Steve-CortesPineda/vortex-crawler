import type { VortexPlugin, CrawlResult } from '@vortex/core';

interface VideoDetails {
  title: string;
  author: string;
  channelId: string;
  viewCount: string;
  lengthSeconds: string;
  shortDescription: string;
  keywords: string[];
  thumbnail: { thumbnails: Array<{ url: string; width: number; height: number }> };
  isLiveContent: boolean;
}

interface CommentThread {
  comment: {
    commentRenderer: {
      authorText: { simpleText: string };
      contentText: { runs: Array<{ text: string }> };
      voteCount?: { simpleText: string };
      publishedTimeText: { runs: Array<{ text: string }> };
    };
  };
}

/**
 * YouTube extractor plugin.
 * Extracts video data from YouTube's embedded JSON (ytInitialData / ytInitialPlayerResponse).
 * No browser rendering needed — YouTube embeds all data in the initial HTML.
 */
export function youtubeExtractor(): VortexPlugin {
  return {
    name: 'youtube-extractor',

    // Override the markdown output for YouTube pages
    afterProcess(result: CrawlResult): CrawlResult {
      if (!isYouTubeUrl(result.url)) return result;

      const playerData = extractPlayerResponse(result.html);
      const initialData = extractInitialData(result.html);

      // Video page
      if (playerData?.videoDetails) {
        const video = playerData.videoDetails;
        const comments = extractComments(initialData);
        const chapters = extractChapters(initialData);
        const relatedVideos = extractRelated(initialData);

        const markdown = buildMarkdown(video, comments, chapters, relatedVideos, result.url);

        return {
          ...result,
          markdown,
          text: markdown.replace(/[#*_`\[\]()>|-]/g, '').replace(/\s+/g, ' ').trim(),
          metadata: {
            ...result.metadata,
            title: video.title,
            author: video.author,
            description: video.shortDescription,
            ogImage: video.thumbnail?.thumbnails?.at(-1)?.url,
          },
          extracted: {
            type: 'video',
            videoId: extractVideoId(result.url),
            title: video.title,
            author: video.author,
            channelId: video.channelId,
            views: parseInt(video.viewCount, 10),
            duration: parseInt(video.lengthSeconds, 10),
            description: video.shortDescription,
            keywords: video.keywords || [],
            isLive: video.isLiveContent,
            thumbnails: video.thumbnail?.thumbnails || [],
            chapters,
            commentCount: comments.length,
            comments: comments.slice(0, 20),
            relatedVideos: relatedVideos.slice(0, 10),
          },
        };
      }

      // Channel / playlist / search page — extract from ytInitialData
      if (initialData) {
        const channelData = extractChannelData(initialData);
        const videoList = extractVideoList(initialData);

        if (channelData || videoList.length > 0) {
          const markdown = buildChannelMarkdown(channelData, videoList, result.url);
          return {
            ...result,
            markdown,
            text: markdown.replace(/[#*_`\[\]()>|-]/g, '').replace(/\s+/g, ' ').trim(),
            metadata: {
              ...result.metadata,
              title: channelData?.name || result.metadata.title,
              author: channelData?.name,
              description: channelData?.description || '',
            },
            extracted: {
              type: 'channel',
              ...channelData,
              videos: videoList,
            },
          };
        }
      }

      return result;
    },
  };
}

function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com'
      || u.hostname === 'm.youtube.com' || u.hostname === 'youtu.be';
  } catch {
    return false;
  }
}

function extractVideoId(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    return u.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function extractPlayerResponse(html: string): any {
  const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractInitialData(html: string): any {
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractComments(data: any): Array<{ author: string; text: string; likes: string; time: string }> {
  if (!data) return [];
  const comments: Array<{ author: string; text: string; likes: string; time: string }> = [];

  try {
    // Comments are deeply nested in ytInitialData
    const items = findNestedKey(data, 'commentThreadRenderer');
    for (const item of items) {
      const renderer = item?.comment?.commentRenderer;
      if (!renderer) continue;

      comments.push({
        author: renderer.authorText?.simpleText || '',
        text: renderer.contentText?.runs?.map((r: any) => r.text).join('') || '',
        likes: renderer.voteCount?.simpleText || '0',
        time: renderer.publishedTimeText?.runs?.map((r: any) => r.text).join('') || '',
      });
    }
  } catch {
    // Comments might not be loaded in initial data
  }

  return comments;
}

function extractChapters(data: any): Array<{ title: string; time: number }> {
  if (!data) return [];
  const chapters: Array<{ title: string; time: number }> = [];

  try {
    const items = findNestedKey(data, 'chapterRenderer');
    for (const ch of items) {
      chapters.push({
        title: ch.title?.simpleText || ch.title?.runs?.map((r: any) => r.text).join('') || '',
        time: ch.timeRangeStartMillis ? ch.timeRangeStartMillis / 1000 : 0,
      });
    }
  } catch {
    // No chapters
  }

  return chapters;
}

function extractRelated(data: any): Array<{ title: string; videoId: string; author: string; views: string }> {
  if (!data) return [];
  const related: Array<{ title: string; videoId: string; author: string; views: string }> = [];

  try {
    const items = findNestedKey(data, 'compactVideoRenderer');
    for (const item of items.slice(0, 10)) {
      related.push({
        title: item.title?.simpleText || item.title?.runs?.map((r: any) => r.text).join('') || '',
        videoId: item.videoId || '',
        author: item.longBylineText?.runs?.[0]?.text || item.shortBylineText?.runs?.[0]?.text || '',
        views: item.viewCountText?.simpleText || item.shortViewCountText?.simpleText || '',
      });
    }
  } catch {
    // No related
  }

  return related;
}

/** Recursively find all objects with a specific key */
function findNestedKey(obj: any, key: string, results: any[] = []): any[] {
  if (!obj || typeof obj !== 'object') return results;

  if (key in obj) {
    results.push(obj[key]);
  }

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        findNestedKey(item, key, results);
      }
    } else if (typeof val === 'object' && val !== null) {
      findNestedKey(val, key, results);
    }
  }

  return results;
}

interface ChannelData {
  name: string;
  handle: string;
  description: string;
  subscribers: string;
  videoCount: string;
  avatar: string;
  banner: string;
}

function extractChannelData(data: any): ChannelData | null {
  try {
    // Channel metadata from header
    const headers = findNestedKey(data, 'c4TabbedHeaderRenderer');
    const pageHeaders = findNestedKey(data, 'pageHeaderRenderer');
    const metadata = findNestedKey(data, 'channelMetadataRenderer');

    const meta = metadata[0];
    const header = headers[0] || pageHeaders[0];

    if (!meta && !header) return null;

    return {
      name: meta?.title || header?.title || '',
      handle: meta?.vanityChannelUrl?.split('/').pop() || '',
      description: meta?.description || '',
      subscribers: header?.subscriberCountText?.simpleText || '',
      videoCount: header?.videosCountText?.runs?.map((r: any) => r.text).join('') || '',
      avatar: meta?.avatar?.thumbnails?.at(-1)?.url || '',
      banner: header?.banner?.thumbnails?.at(-1)?.url || '',
    };
  } catch {
    return null;
  }
}

function extractVideoList(data: any): Array<{ title: string; videoId: string; views: string; duration: string; published: string }> {
  const videos: Array<{ title: string; videoId: string; views: string; duration: string; published: string }> = [];

  try {
    // 2025+ layout: lockupViewModel inside richItemRenderer
    const lockups = findNestedKey(data, 'lockupViewModel');
    for (const lockup of lockups.slice(0, 30)) {
      const videoId = lockup.contentId || '';
      const title = lockup.metadata?.lockupMetadataViewModel?.title?.content || '';
      const metaRows = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];

      let views = '';
      let published = '';
      for (const row of metaRows) {
        for (const part of row.metadataParts || []) {
          const text = part.text?.content || '';
          if (text.includes('view')) views = text;
          else if (text.includes('ago') || text.includes('month') || text.includes('year') || text.includes('day') || text.includes('hour')) published = text;
        }
      }

      const duration = lockup.contentImage?.thumbnailViewModel?.overlays?.[0]
        ?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text || '';

      if (videoId) {
        videos.push({ title, videoId, views, duration, published });
      }
    }

    // Fallback: older gridVideoRenderer layout
    if (videos.length === 0) {
      const gridItems = findNestedKey(data, 'gridVideoRenderer');
      for (const item of gridItems.slice(0, 30)) {
        videos.push({
          title: item.title?.simpleText || item.title?.runs?.map((r: any) => r.text).join('') || '',
          videoId: item.videoId || '',
          views: item.viewCountText?.simpleText || item.shortViewCountText?.simpleText || '',
          duration: item.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '',
          published: item.publishedTimeText?.simpleText || '',
        });
      }
    }

    // Fallback: videoRenderer inside richItemRenderer (mid-2024 layout)
    if (videos.length === 0) {
      const richItems = findNestedKey(data, 'richItemRenderer');
      for (const item of richItems.slice(0, 30)) {
        const content = item.content?.videoRenderer;
        if (!content) continue;
        videos.push({
          title: content.title?.runs?.map((r: any) => r.text).join('') || '',
          videoId: content.videoId || '',
          views: content.viewCountText?.simpleText || content.shortViewCountText?.simpleText || '',
          duration: content.lengthText?.simpleText || '',
          published: content.publishedTimeText?.simpleText || '',
        });
      }
    }
  } catch {
    // No videos found
  }

  return videos;
}

function buildChannelMarkdown(
  channel: ChannelData | null,
  videos: Array<{ title: string; videoId: string; views: string; duration: string; published: string }>,
  url: string
): string {
  const lines: string[] = [];

  if (channel) {
    lines.push(`# ${channel.name}`);
    lines.push('');
    if (channel.handle) lines.push(`**${channel.handle}** | ${channel.subscribers} | ${channel.videoCount}`);
    lines.push('');
    if (channel.description) {
      lines.push('## About');
      lines.push('');
      lines.push(channel.description);
      lines.push('');
    }
  }

  if (videos.length > 0) {
    lines.push('## Videos');
    lines.push('');
    for (const v of videos) {
      const meta = [v.duration, v.views, v.published].filter(Boolean).join(' | ');
      lines.push(`- [${v.title}](https://www.youtube.com/watch?v=${v.videoId}) — ${meta}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildMarkdown(
  video: VideoDetails,
  comments: Array<{ author: string; text: string; likes: string; time: string }>,
  chapters: Array<{ title: string; time: number }>,
  related: Array<{ title: string; videoId: string; author: string; views: string }>,
  url: string
): string {
  const views = parseInt(video.viewCount, 10);
  const duration = parseInt(video.lengthSeconds, 10);
  const lines: string[] = [];

  lines.push(`# ${video.title}`);
  lines.push('');
  lines.push(`**${video.author}** | ${formatViews(views)} views | ${formatDuration(duration)}`);
  lines.push('');

  // Description
  if (video.shortDescription) {
    lines.push('## Description');
    lines.push('');
    lines.push(video.shortDescription);
    lines.push('');
  }

  // Keywords
  if (video.keywords?.length) {
    lines.push(`**Tags:** ${video.keywords.join(', ')}`);
    lines.push('');
  }

  // Chapters
  if (chapters.length > 0) {
    lines.push('## Chapters');
    lines.push('');
    for (const ch of chapters) {
      lines.push(`- **${formatTimestamp(ch.time)}** — ${ch.title}`);
    }
    lines.push('');
  }

  // Top Comments
  if (comments.length > 0) {
    lines.push(`## Top Comments (${comments.length})`);
    lines.push('');
    for (const c of comments.slice(0, 10)) {
      lines.push(`> **${c.author}** (${c.likes} likes, ${c.time})`);
      lines.push(`> ${c.text}`);
      lines.push('');
    }
  }

  // Related Videos
  if (related.length > 0) {
    lines.push('## Related Videos');
    lines.push('');
    for (const r of related) {
      lines.push(`- [${r.title}](https://www.youtube.com/watch?v=${r.videoId}) — ${r.author} (${r.views})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
