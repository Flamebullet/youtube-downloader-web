const express = require('express');
const https = require('https');
const path = require('path');
const app = express();
// Downloading/file management modules
// const ytdl = require('ytdl-core');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const cp = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { Client, SearchResult } = require('youtubei');
const youtube = new Client();
const { spotifyId, spotifySecret, databaseUrl } = require('./cred.js');
const spotifyInfo = require('spotify-info');
spotifyInfo.setApiCredentials(spotifyId, spotifySecret);
const postgres = require('postgres');
const axios = require('axios');

// progress bar object
const progbarobj = {};
const sql = postgres(databaseUrl, {
	idle_timeout: 5
});

// agent should be created once if you don't want to change your cookie
const agent = ytdl.createAgent(JSON.parse(fs.readFileSync('cookie.json')));

// Code to serve images
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function throwError(res, err) {
	return res.redirect(`/error?err=${err}`);
}

function secToStr(sec) {
	if (sec === null || sec === undefined) return '0:00';

	totalSeconds = sec;
	let hours = Math.floor(totalSeconds / 3600).toLocaleString('en-US', {
		minimumIntegerDigits: 2,
		useGrouping: false
	});
	totalSeconds %= 3600;
	let minutes = Math.floor(totalSeconds / 60).toLocaleString('en-US', {
		minimumIntegerDigits: 2,
		useGrouping: false
	});
	let seconds = (sec % 60).toLocaleString('en-US', {
		minimumIntegerDigits: 2,
		useGrouping: false
	});

	return `${hours}:${minutes}:${seconds}`.replace(/^(?:00:)?0?/, '');
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function convertNum(num) {
	let result;
	if (num >= 1000000) {
		result = (num / 1000000).toFixed(1) + 'M';
	} else if (num >= 1000) {
		result = (num / 1000).toFixed(1) + 'K';
	} else {
		result = num.toString();
	}
	// Remove .0 from the result
	return result.replace('.0', '');
}

async function downloadImage(url, path) {
	await axios({
		method: 'get',
		url: url,
		responseType: 'stream'
	}).then(function (response) {
		response.data.pipe(fs.createWriteStream(path));
	});
	return;
}

// OUR ROUTES WILL GO HERE
const key = fs.readFileSync(`${__dirname}\\certs\\domain.key`);
const cert = fs.readFileSync(`${__dirname}\\certs\\domain.crt`);
const server = https.createServer({ key: key, cert: cert }, app);

const port = 443;
server.listen(port, () => {
	console.log(`Server is running on https://localhost:${port}`);
});

// home page
app.get('/', (req, res) => {
	const err = req.query.err ? req.query.err : null;

	return res.render('index', { err: err });
});

// search page
app.get('/search', async (req, res) => {
	const { url, video, audio, thumbnail } = req.query;
	const continuation = req.query.continuation ? req.query.continuation : null;
	let results;

	if (continuation) {
		const encodedcont = JSON.parse(decodeURIComponent(continuation));
		let decodedcont = new SearchResult({ client: new Client(encodedcont.searchCont.client) });
		decodedcont.continuation = encodedcont.searchCont.continuation;
		results = await decodedcont.next();

		for (var result of results) {
			result.client = null;
			result.thumbnail = result.thumbnails[0].url;
			result.thumbnails = null;
			result.channel.client = null;
			result.channel.shorts = null;
			result.channel.live = null;
			result.channel.videos = null;
			result.channel.playlists = null;
			result.url = `https://www.youtube.com/watch?v=${result.id}`;
			result.timestamp = secToStr(result.duration);
		}

		if (results.length == 0) {
			decodedcont = null;
		}

		return res.status(200).json({
			JSONresults: encodeURIComponent(JSON.stringify({ results })),
			continuation: encodeURIComponent(JSON.stringify({ decodedcont })),
			results: results,
			video: video,
			audio: audio,
			thumbnail: thumbnail
		});
	} else {
		await youtube
			.search(url, { type: 'video' })
			.then(async (r) => {
				if (r.length === 0) return res.redirect(`/?err=${encodeURIComponent(`No videos found from "${url}"`)}`);
				results = r.items;
				for (var result of results) {
					result.client = null;
					result.thumbnail = result.thumbnails[0].url;
					result.thumbnails = null;
					result.channel.client = null;
					result.channel.shorts = null;
					result.channel.live = null;
					result.channel.videos = null;
					result.channel.playlists = null;
					result.url = `https://www.youtube.com/watch?v=${result.id}`;
					result.timestamp = secToStr(result.duration);
				}

				let searchCont;
				if (r.continuation) {
					searchCont = { client: r.client, continuation: r.continuation };
				} else {
					searchCont = null;
				}

				return res.render('search', {
					JSONresults: encodeURIComponent(JSON.stringify({ results })),
					continuation: encodeURIComponent(JSON.stringify({ searchCont })),
					results: results,
					video: video,
					audio: audio,
					thumbnail: thumbnail
				});
			})
			.catch(async (err) => {
				console.log(err);
				return res.redirect(`/?err=${encodeURIComponent(err)}`);
			});
	}
	return;
});

app.get('/playlist', async (req, res) => {
	const { url, video, audio, thumbnail } = req.query;

	function playlistUrlToId(url) {
		const youtubePlaylistRegex = /^\<?(https?:\/\/)?((w{3}\.)|(music\.))?(youtube\.com\/(playlist\?list\=))(?<urlkey>[\S]{23,41})\>?/gm;
		const urlkey = youtubePlaylistRegex.exec(url);
		return urlkey?.groups?.urlkey;
	}

	let playlist = await youtube.getPlaylist(playlistUrlToId(url)).catch(async (err) => {
		console.log(err);
		return res.redirect(`/?err=${encodeURIComponent(err)}`);
	});

	if (playlist === undefined) return res.redirect(`/?err=${encodeURIComponent(`No playlist found from "${url}"`)}, check that playlist is set to unlisted`);

	if (playlist.continuation) await playlist.next(0);
	const results = new Array(playlist.videos.items.length);

	await Promise.all(
		playlist.videos.items.map(async (item, index) => {
			while (true) {
				try {
					var result = await youtube.getVideo(item.id);
					result.client = null;
					result.related = null;
					result.comments = null;
					result.thumbnail = result.thumbnails[result.thumbnails.length - 1].url;
					result.thumbnails = null;
					result.channel.client = null;
					result.channel.shorts = null;
					result.channel.live = null;
					result.channel.videos = null;
					result.channel.playlists = null;
					result.url = `https://www.youtube.com/watch?v=${result.id}`;
					result.timestamp = secToStr(result.duration);
					result.captions = null;

					results[index] = result;
					break;
				} catch (err) {
					await sleep(1000);
				}
			}
		})
	);

	return res.render('playlist', {
		JSONresults: encodeURIComponent(JSON.stringify({ results })),
		results: results,
		video: video,
		audio: audio,
		thumbnail: thumbnail,
		title: playlist.videos.playlist.title
	});
});

// Select quality page
app.get('/download', async (req, res) => {
	let title, videoFormats;
	const videoSelect = req.query.video ? req.query.video : 'off';
	const audioSelect = req.query.audio ? req.query.audio : 'off';
	const thumbnailSelect = req.query.thumbnail ? req.query.thumbnail : 'off';
	let { url } = req.query;
	const { videoItag, dl, uid } = req.query;
	let { timeStart, timeEnd } = req.query;

	if (url == '') return res.redirect(`/?err=${encodeURIComponent('URL cannot be empty')}`);
	if (videoSelect == 'off' && audioSelect == 'off')
		return res.redirect(`/?err=${encodeURIComponent('Please select a video or audio format')}&url=${encodeURIComponent(url)}`);

	if (spotifyInfo.validateTrackURL(url)) {
		try {
			let track = await spotifyInfo.getTrack(url);

			await youtube.search(`${track.name} ${track.artists[0].name}`, { type: 'video' }).then(async (r) => {
				let durationList = [];
				const goal = Math.round(track.duration / 1000);
				r.items.map((v) => durationList.push(v.duration));
				var closest = durationList.reduce(function (prev, curr) {
					return Math.abs(curr - goal) < Math.abs(prev - goal) ? curr : prev;
				});

				for (const song of r.items) {
					if (song.duration == closest) {
						url = `https://www.youtube.com/watch?v=${song.id}`;
						break;
					}
				}
			});
		} catch (err) {
			console.log(err);
			return res.redirect(`/?err=${encodeURIComponent('Invalid Spotify Track URL entered!')}`);
		}
	}

	try {
		const youtubePlaylistRegex = /^\<?(https?:\/\/)?((w{3}\.)|(music\.))?(youtube\.com\/(playlist\?list\=))(?<urlkey>[\S]{23,41})\>?/gm;
		if (url.match(youtubePlaylistRegex))
			return res.redirect(`/playlist?url=${encodeURIComponent(url)}&video=${videoSelect}&audio=${audioSelect}&thumbnail=${thumbnailSelect}`);
		// Create the video quality selection dropdown menu
		const video = await ytdl.getInfo(url, agent).catch(() => {
			return res.redirect(`/search?url=${encodeURIComponent(url)}&video=${videoSelect}&audio=${audioSelect}&thumbnail=${thumbnailSelect}`);
		});
		if (!video) return;

		const videoDetails = video.videoDetails;
		let target = ' - Topic';
		let pos = videoDetails.ownerChannelName.lastIndexOf(target);
		if (pos !== -1) {
			videoDetails.ownerChannelName = videoDetails.ownerChannelName.substring(0, pos) + videoDetails.ownerChannelName.substring(pos + target.length);
		}

		const songCard = video.response.engagementPanels[1].engagementPanelSectionListRenderer.content.structuredDescriptionContentRenderer?.items[2]
			? video.response.engagementPanels[1].engagementPanelSectionListRenderer.content.structuredDescriptionContentRenderer?.items[2]
					.horizontalCardListRenderer?.cards
			: null;
		const artist =
			songCard?.length == 1 && songCard[0].videoAttributeViewModel.subtitle.toLowerCase() != videoDetails.ownerChannelName.toLowerCase()
				? `${videoDetails.ownerChannelName}, ${songCard[0].videoAttributeViewModel.subtitle}`
				: videoDetails.ownerChannelName;

		if ((videoDetails.isLiveContent || videoDetails.isLive) && videoDetails.liveBroadcastDetails.isLiveNow)
			return res.redirect(`/?err=${encodeURIComponent('Selected video is a live stream, please select a different video.')}`);
		async function downloadVideo(videoItag, videoDetails) {
			const tracker = {
				start: Date.now(),
				audio: { downloaded: 0, total: Infinity },
				video: { downloaded: 0, total: Infinity },
				merged: { frame: 0, speed: '0x', fps: 0 }
			};

			let audio, video;
			if (audioSelect == 'on') {
				audio = ytdl(videoDetails.video_url, {
					filter: 'audioonly',
					quality: 'highestaudio',
					playerClients: ['ANDROID', 'IOS']
				}).on('progress', (_, downloaded, total) => {
					tracker.audio = { downloaded, total };
				});
			}

			if (videoSelect == 'on') {
				video = ytdl(videoDetails.video_url, {
					quality: `${videoItag}`,
					playerClients: ['ANDROID', 'IOS']
				}).on('progress', (_, downloaded, total) => {
					tracker.video = { downloaded, total };
				});
			}

			let progressbarHandle = null;
			const progressbarInterval = 1000;

			function convertDecimalMinutes(decimalMinutes) {
				let minutes = Math.floor(decimalMinutes);
				let seconds = parseFloat(((decimalMinutes - minutes) * 60).toFixed(2));
				let minuteText = minutes === 1 ? ' minute ' : ' minutes ';
				let secondText = seconds === 1 ? ' second' : ' seconds';
				if (minutes > 0) {
					return minutes + minuteText + seconds + secondText;
				} else {
					return seconds + secondText;
				}
			}

			const showProgress = () => {
				const toMB = (i) => (i / 1024 / 1024).toFixed(2);

				let progress = `Audio  | ${((tracker.audio.downloaded / tracker.audio.total) * 100).toFixed(2)}% processed `;
				progress += `(${toMB(tracker.audio.downloaded)}MB of ${toMB(tracker.audio.total)}MB).${' '.repeat(10)}\n`;

				progress += `Video  | ${((tracker.video.downloaded / tracker.video.total) * 100).toFixed(2)}% processed `;
				progress += `(${toMB(tracker.video.downloaded)}MB of ${toMB(tracker.video.total)}MB).${' '.repeat(10)}\n`;

				progress += `Merged | processing frame ${tracker.merged.frame} `;
				progress += `(at ${tracker.merged.fps} fps → ${tracker.merged.speed}).${' '.repeat(10)}\n\n`;

				progress += `Running for: ${convertDecimalMinutes(((Date.now() - tracker.start) / 1000 / 60).toFixed(2))}.`;

				Object.assign(progbarobj, { [uid]: progress });
			};

			let filename;
			if (videoSelect == 'on') {
				filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.mp4`;
			} else {
				filename = `${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.mp3`;
			}

			// If file already exist remove the old file
			if (fs.existsSync(filename)) {
				fs.unlink(filename, () => {
					return;
				});
			}

			const startTime = timeStart;
			function getTimeDifference() {
				// Ensure times are in HH:MM:SS format
				if (timeStart.split(':').length === 2) {
					timeStart = `00:${timeStart}`;
				}
				if (timeEnd.split(':').length === 2) {
					timeEnd = `00:${timeEnd}`;
				}

				const [h1, m1, s1] = timeStart.split(':').map(Number);
				const [h2, m2, s2] = timeEnd.split(':').map(Number);

				const totalSeconds1 = (h1 || 0) * 3600 + (m1 || 0) * 60 + (s1 || 0);
				const totalSeconds2 = (h2 || 0) * 3600 + (m2 || 0) * 60 + (s2 || 0);

				let diffSeconds = Math.abs(totalSeconds2 - totalSeconds1);

				const hours = Math.floor(diffSeconds / 3600);
				diffSeconds %= 3600;
				const minutes = Math.floor(diffSeconds / 60);
				const seconds = diffSeconds % 60;

				return hours > 0
					? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
					: `${minutes}:${seconds.toString().padStart(2, '0')}`;
			}

			function compareTimes(time1, time2) {
				const [h1, m1, s1] = time1.split(':').map(Number);
				const [h2, m2, s2] = time2.split(':').map(Number);

				const totalSeconds1 = (h1 || 0) * 3600 + (m1 || 0) * 60 + (s1 || 0);
				const totalSeconds2 = (h2 || 0) * 3600 + (m2 || 0) * 60 + (s2 || 0);

				return totalSeconds1 - totalSeconds2;
			}

			function timeToSeconds(time) {
				if (time.split(':').length === 2) {
					time = `00:${time}`;
				}
				const [hours, minutes, seconds] = time.split(':').map(Number);
				return hours * 3600 + minutes * 60 + seconds;
			}

			const timeDiff = timeStart && timeEnd && compareTimes(timeStart, timeEnd) < 0 ? getTimeDifference() : null;
			if (audioSelect == 'on' && videoSelect == 'on') {
				// Start the ffmpeg child process
				if (timeDiff && parseInt(videoDetails.lengthSeconds) > timeToSeconds(timeDiff)) {
					const ffmpegProcess = cp.spawn(
						ffmpeg,
						[
							// Remove ffmpeg's console spamming
							'-loglevel',
							'8',
							'-hide_banner',
							// Redirect/Enable progress messages
							'-progress',
							'pipe:3',
							// Set inputs
							'-i',
							'pipe:4',
							'-i',
							'pipe:5',
							'-ss',
							timeToSeconds(startTime),
							// Map audio & video from streams
							'-map',
							'0:a',
							'-map',
							'1:v',
							'-t',
							timeToSeconds(timeDiff),
							// Keep encoding
							'-crf',
							'18',
							// Define output file
							filename
						],
						{
							windowsHide: true,
							stdio: [
								/* Standard: stdin, stdout, stderr */
								'inherit',
								'inherit',
								'inherit',
								/* Custom: pipe:3, pipe:4, pipe:5 */
								'pipe',
								'pipe',
								'pipe'
							]
						}
					);

					ffmpegProcess.on('close', async () => {
						clearInterval(progressbarHandle);
						Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
						return res.status(200).json({ file: encodeURIComponent(filename) });
					});

					// Link streams
					// FFmpeg creates the transformer streams and we just have to insert / read data
					ffmpegProcess.stdio[3].on('data', (chunk) => {
						// Start the progress bar
						if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);

						// Parse the param=value list returned by ffmpeg
						const lines = chunk.toString().trim().split('\n');
						const args = {};
						for (const l of lines) {
							const [key, value] = l.split('=');
							args[key.trim()] = value.trim();
						}
						tracker.merged = args;
					});

					ffmpegProcess.stdio[4].on('error', (err) => {});
					ffmpegProcess.stdio[5].on('error', (err) => {});
					audio.pipe(ffmpegProcess.stdio[4]).on('error', (err) => {});
					video.pipe(ffmpegProcess.stdio[5]).on('error', (err) => {});
				} else {
					const ffmpegProcess = cp.spawn(
						ffmpeg,
						[
							// Remove ffmpeg's console spamming
							'-loglevel',
							'8',
							'-hide_banner',
							// Redirect/Enable progress messages
							'-progress',
							'pipe:3',
							// Set inputs
							'-i',
							'pipe:4',
							'-i',
							'pipe:5',
							// Map audio & video from streams
							'-map',
							'0:a',
							'-map',
							'1:v',
							// Keep encoding
							'-c',
							'copy',
							'-crf',
							'18',
							// Define output file
							filename
						],
						{
							windowsHide: true,
							stdio: [
								/* Standard: stdin, stdout, stderr */
								'inherit',
								'inherit',
								'inherit',
								/* Custom: pipe:3, pipe:4, pipe:5 */
								'pipe',
								'pipe',
								'pipe'
							]
						}
					);

					ffmpegProcess.on('close', async () => {
						clearInterval(progressbarHandle);
						Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
						return res.status(200).json({ file: encodeURIComponent(filename) });
					});

					// Link streams
					// FFmpeg creates the transformer streams and we just have to insert / read data
					ffmpegProcess.stdio[3].on('data', (chunk) => {
						// Start the progress bar
						if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);

						// Parse the param=value list returned by ffmpeg
						const lines = chunk.toString().trim().split('\n');
						const args = {};
						for (const l of lines) {
							const [key, value] = l.split('=');
							args[key.trim()] = value.trim();
						}
						tracker.merged = args;
					});

					audio.pipe(ffmpegProcess.stdio[4]);
					video.pipe(ffmpegProcess.stdio[5]);
				}
			} else if (audioSelect == 'on') {
				if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);

				// output audio as mp3 file
				if (thumbnailSelect == 'on') {
					await downloadImage(
						videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
						`${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.jpg`
					);

					if (timeDiff && parseInt(videoDetails.lengthSeconds) > timeToSeconds(timeDiff)) {
						const ffmpegProcess = cp.spawn(
							ffmpeg,
							[
								// Remove ffmpeg's console spamming
								'-loglevel',
								'8',
								'-hide_banner',
								'-ss',
								timeToSeconds(startTime),
								// Redirect/Enable progress messages
								'-progress',
								'pipe:3',
								// Set inputs
								'-i',
								'pipe:4',
								// Map audio & video from streams
								'-i',
								`${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.jpg`,
								'-t',
								timeToSeconds(timeDiff),
								'-map',
								'0',
								'-map',
								'1',
								'-codec:a',
								'libmp3lame',
								'-qscale:a',
								'0',
								'-metadata',
								`title=${videoDetails.title}`, // Set track name (title)
								'-metadata',
								`artist=${artist}`, // Set performer (artist)
								'-metadata',
								`album=${videoDetails.title}`, // Set album name
								'-y',
								filename
							],
							{
								windowsHide: true,
								stdio: [
									/* Standard: stdin, stdout, stderr */
									'inherit',
									'inherit',
									'inherit',
									/* Custom: pipe:3, pipe:4, pipe:5 */
									'pipe',
									'pipe'
								]
							}
						);

						ffmpegProcess.on('close', async () => {
							clearInterval(progressbarHandle);
							Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
							fs.unlink(`${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.jpg`, () => {
								return;
							});
							return res.status(200).json({ file: encodeURIComponent(filename) });
						});

						ffmpegProcess.stdio[4].on('error', (err) => {});

						audio.pipe(ffmpegProcess.stdio[4]).on('error', (err) => {});
					} else {
						const ffmpegProcess = cp.spawn(
							ffmpeg,
							[
								// Remove ffmpeg's console spamming
								'-loglevel',
								'8',
								'-hide_banner',
								// Redirect/Enable progress messages
								'-progress',
								'pipe:3',
								// Set inputs
								'-i',
								'pipe:4',
								// Map audio & video from streams
								'-i',
								`${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.jpg`,
								'-map',
								'0',
								'-map',
								'1',
								'-codec:a',
								'libmp3lame',
								'-qscale:a',
								'0',
								'-metadata',
								`title=${videoDetails.title}`, // Set track name (title)
								'-metadata',
								`artist=${artist}`, // Set performer (artist)
								'-metadata',
								`album=${videoDetails.title}`, // Set album name
								'-y',
								filename
							],
							{
								windowsHide: true,
								stdio: [
									/* Standard: stdin, stdout, stderr */
									'inherit',
									'inherit',
									'inherit',
									/* Custom: pipe:3, pipe:4, pipe:5 */
									'pipe',
									'pipe'
								]
							}
						);

						ffmpegProcess.on('close', async () => {
							clearInterval(progressbarHandle);
							Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
							fs.unlink(`${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.jpg`, () => {
								return;
							});
							return res.status(200).json({ file: encodeURIComponent(filename) });
						});

						audio.pipe(ffmpegProcess.stdio[4]);
					}
				} else {
					if (timeDiff && parseInt(videoDetails.lengthSeconds) > timeToSeconds(timeDiff)) {
						const ffmpegProcess = cp.spawn(
							ffmpeg,
							[
								// Remove ffmpeg's console spamming
								'-loglevel',
								'8',
								'-hide_banner',
								'-ss',
								timeToSeconds(startTime),
								// Redirect/Enable progress messages
								'-progress',
								'pipe:3',
								// Set inputs
								'-i',
								'pipe:4',
								// Map audio & video from streams
								'-t',
								timeToSeconds(timeDiff),
								'-map',
								'0:a',
								'-codec:a',
								'libmp3lame',
								'-qscale:a',
								'0',
								'-metadata',
								`title=${videoDetails.title}`, // Set track name (title)
								'-metadata',
								`artist=${artist}`, // Set performer (artist)
								'-metadata',
								`album=${videoDetails.title}`, // Set album name
								'-y',
								filename
							],
							{
								windowsHide: true,
								stdio: [
									/* Standard: stdin, stdout, stderr */
									'inherit',
									'inherit',
									'inherit',
									/* Custom: pipe:3, pipe:4, pipe:5 */
									'pipe',
									'pipe'
								]
							}
						);

						ffmpegProcess.on('close', async () => {
							clearInterval(progressbarHandle);
							Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
							fs.unlink(`${__dirname}\\tmp\\${videoDetails.title.replaceAll(/\*|\.|\?|\"|\/|\\|\:|\||\<|\>/gi, '')}.jpg`, () => {
								return;
							});
							return res.status(200).json({ file: encodeURIComponent(filename) });
						});

						ffmpegProcess.stdio[4].on('error', (err) => {});

						audio.pipe(ffmpegProcess.stdio[4]).on('error', (err) => {});
					} else {
						const ffmpegProcess = cp.spawn(
							ffmpeg,
							[
								// Remove ffmpeg's console spamming
								'-loglevel',
								'8',
								'-hide_banner',
								// Redirect/Enable progress messages
								'-progress',
								'pipe:3',
								// Set inputs
								'-i',
								'pipe:4',
								// Map audio & video from streams
								'-map',
								'0:a',
								'-codec:a',
								'libmp3lame',
								'-qscale:a',
								'0',
								'-metadata',
								`title=${videoDetails.title}`, // Set track name (title)
								'-metadata',
								`artist=${artist}`, // Set performer (artist)
								'-metadata',
								`album=${videoDetails.title}`, // Set album name
								'-y',
								filename
							],
							{
								windowsHide: true,
								stdio: [
									/* Standard: stdin, stdout, stderr */
									'inherit',
									'inherit',
									'inherit',
									/* Custom: pipe:3, pipe:4, pipe:5 */
									'pipe',
									'pipe'
								]
							}
						);

						ffmpegProcess.on('close', async () => {
							clearInterval(progressbarHandle);
							Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
							return res.status(200).json({ file: encodeURIComponent(filename) });
						});

						audio.pipe(ffmpegProcess.stdio[4]);
					}
				}
			} else if (videoSelect == 'on') {
				if (timeDiff && parseInt(videoDetails.lengthSeconds) > timeToSeconds(timeDiff)) {
					const ffmpegProcess = cp.spawn(
						ffmpeg,
						[
							// Remove ffmpeg's console spamming
							'-loglevel',
							'8',
							'-hide_banner',
							// Redirect/Enable progress messages
							'-progress',
							'pipe:3',
							// Set inputs
							'-i',
							'pipe:4',
							'-map',
							'0:v',
							'-map_metadata',
							'-1',
							// Keep encoding
							'-ss',
							timeToSeconds(startTime),
							'-t',
							timeToSeconds(timeDiff),
							'-crf',
							'18',
							// Define output file
							filename
						],
						{
							windowsHide: true,
							stdio: [
								/* Standard: stdin, stdout, stderr */
								'inherit',
								'inherit',
								'inherit',
								/* Custom: pipe:3, pipe:4, pipe:5 */
								'pipe',
								'pipe'
							]
						}
					);

					ffmpegProcess.on('close', async () => {
						clearInterval(progressbarHandle);
						Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
						return res.status(200).json({ file: encodeURIComponent(filename) });
					});

					ffmpegProcess.stdio[4].on('error', (err) => {});

					video.pipe(ffmpegProcess.stdio[4]).on('error', (err) => {});
				} else {
					if (!progressbarHandle) progressbarHandle = setInterval(showProgress, progressbarInterval);
					video.pipe(fs.createWriteStream(filename));
					video.on('end', () => {
						clearInterval(progressbarHandle);
						Object.assign(progbarobj, { [uid]: `Done ${encodeURIComponent(filename)}` });
						return res.status(200).json({ file: encodeURIComponent(filename) });
					});
				}
			}
		}

		if (dl) return await downloadVideo(videoItag, videoDetails);

		videoDetails.availableCountries = null;
		videoDetails.keywords = null;
		let subscribers = convertNum(videoDetails.author.subscriber_count);

		title = videoDetails.title;

		if (videoSelect == 'on') videoFormats = ytdl.filterFormats(video.formats, 'videoonly');

		return res.render('download', {
			url: video.videoDetails.embed.iframeUrl,
			title: title,
			author: encodeURIComponent(JSON.stringify(videoDetails.author)),
			subscribers: subscribers,
			verified: videoDetails.author.verified,
			videoFormats: videoFormats,
			video: videoSelect,
			audio: audioSelect,
			thumbnail: thumbnailSelect,
			videoDetails: encodeURIComponent(JSON.stringify(videoDetails))
		});
	} catch (err) {
		throwError(res, err);
	}
});

// Download page
app.get('/download/download', async function (req, res) {
	const file = decodeURIComponent(req.query.file);

	res.download(file, async (err) => {
		fs.unlink(file, () => {
			return;
		});
	});
});

app.get('/download/progress', async function (req, res) {
	const { uid } = req.query;

	const progress = progbarobj[uid] ? progbarobj[uid] : ' ';

	if (progress.startsWith('Done')) {
		delete progbarobj[uid];
	}

	return res.status(200).json({ progress: progress });
});

// error page
app.get('/error', (req, res) => {
	return res.render('error', { err: req.query.err });
});

// Twitch bot website code
app.get('/twitch-bot/bottercype', async function (req, res) {
	const username = req.query.username ? req.query.username : null;
	const button = req.query.buttonId ? req.query.buttonId : null;

	try {
		if (username && button == 'add') {
			await sql`INSERT INTO testchannels (username) VALUES (${String(username)});`;
		}
	} catch (err) {
		console.log(err);
	}
	return res.render('bottercype');
});

// movie website code
app.get('/movies', async function (req, res) {
	const title = req.query.title ? req.query.title : '';
	const directoryPath = `${__dirname}\\public\\movies`;
	let results = [];

	fs.readdir(directoryPath + title, function (err, files) {
		if (err) {
			if (title.endsWith('.mkv') || title.endsWith('.mp4')) {
				return res.render('movies', {
					JSONresults: encodeURIComponent(JSON.stringify({ results })),
					results: results,
					path: `${title}\\`,
					video: `${title.replace(/\\/g, '/')}`
				});
			} else {
				return console.log('Unable to scan directory: ' + err);
			}
		}
		files.forEach(function (file) {
			results.push(file);
		});
		return res.render('movies', {
			JSONresults: encodeURIComponent(JSON.stringify({ results })),
			results: results,
			path: `${title}\\`,
			video: null
		});
	});
});

app.get('/links', async function (req, res) {
	return res.render('links');
});
