// Packages
import * as SocketIO from 'socket.io';
import * as Sentry from '@sentry/node';

// Ours
import createLogger from '../logger';
import { TypedServerSocket } from '../../types/socket-protocol';

const log = createLogger('nodecg/lib/server');

export default async function(socket: TypedServerSocket, next: SocketIO.NextFunction): Promise<void> {
	try {
		log.trace('New socket connection: ID %s with IP %s', socket.id, (socket as any).handshake.address);

		// Prevent console warnings when many extensions are installed
		(socket as any).setMaxListeners(64);

		socket.on('message', data => {
			log.trace(
				'Received message %s (sent to bundle %s) with data:',
				data.messageName,
				data.bundleName,
				data.content,
			);

			(socket as any).broadcast.emit('message', data);
		});

		socket.on('joinRoom', (room, cb) => {
			if (typeof room !== 'string') {
				return cb('Room must be a string');
			}

			if (!Object.keys((socket as any).rooms).includes(room)) {
				log.trace('Socket %s joined room:', socket.id, room);
				socket.join(room);
			}

			cb(null);
		});

		next();
	} catch (error) {
		next(error);
	}
}
