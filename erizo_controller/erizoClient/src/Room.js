/* global L, io, Erizo*/
this.Erizo = this.Erizo || {};

/*
 * Class Room represents a Licode Room. It will handle the connection, local stream publication and
 * remote stream subscription.
 * Typical Room initialization would be:
 * var room = Erizo.Room({token:'213h8012hwduahd-321ueiwqewq'});
 * It also handles RoomEvents and StreamEvents. For example:
 * Event 'room-connected' points out that the user has been successfully connected to the room.
 * Event 'room-disconnected' shows that the user has been already disconnected.
 * Event 'stream-added' indicates that there is a new stream available in the room.
 * Event 'stream-removed' shows that a previous available stream has been removed from the room.
 */
Erizo.Room = (specInput) => {
  const spec = specInput;
  const that = Erizo.EventDispatcher(specInput);
  const DISCONNECTED = 0;
  const CONNECTING = 1;
  const CONNECTED = 2;

  that.remoteStreams = {};
  that.localStreams = {};
  that.roomID = '';
  that.socket = {};
  that.state = DISCONNECTED;
  that.p2p = false;

  // Private functions

  // It removes the stream from HTML and close the PeerConnection associated
  const removeStream = (streamInput) => {
    const stream = streamInput;
    if (stream.stream !== undefined) {
      // Remove HTML element
      stream.hide();

      // Close PC stream
      if (stream.pc) {
        stream.pc.close();
        delete stream.pc;
      }
      if (stream.local) {
        stream.stream.stop();
      }
      delete stream.stream;
    }
  };

  // Function to send a message to the server using socket.io
  const sendMessageSocket = (type, msg, callback, error) => {
    that.socket.emit(type, msg, (respType, resp) => {
      if (respType === 'success') {
        if (callback) callback(resp);
      } else if (respType === 'error') {
        if (error) error(resp);
      } else if (callback) callback(respType, resp);
    });
  };

  const sendDataSocket = (stream, msg) => {
    if (stream.local) {
      sendMessageSocket('sendDataStream', { id: stream.getID(), msg });
    } else {
      L.Logger.error('You can not send data through a remote stream');
    }
  };

  const updateAttributes = (stream, attrs) => {
    if (stream.local) {
      stream.updateLocalAttributes(attrs);
      sendMessageSocket('updateStreamAttributes', { id: stream.getID(), attrs });
    } else {
      L.Logger.error('You can not update attributes in a remote stream');
    }
  };

  // It sends a SDP message to the server using socket.io
  const sendSDPSocket = (type, options, sdp, callback) => {
    if (that.state !== DISCONNECTED) {
      that.socket.emit(type, options, sdp, (response, respCallback) => {
        if (callback) callback(response, respCallback);
      });
    } else {
      L.Logger.warning('Trying to send a message over a disconnected Socket');
    }
  };

  // It connects to the server through socket.io
  const connectSocket = (token, callback, error) => {
    const createRemotePc = (streamInput, peerSocket) => {
      const stream = streamInput;
      stream.pc = Erizo.Connection({ callback(msg) {
        sendSDPSocket('signaling_message', { streamId: stream.getID(),
          peerSocket,
          msg });
      },
        iceServers: that.iceServers,
        maxAudioBW: spec.maxAudioBW,
        maxVideoBW: spec.maxVideoBW,
        limitMaxAudioBW: spec.maxAudioBW,
        limitMaxVideoBW: spec.maxVideoBW });

      stream.pc.onaddstream = (evt) => {
                // Draw on html
        L.Logger.info('Stream subscribed');
        stream.stream = evt.stream;
        const evt2 = Erizo.StreamEvent({ type: 'stream-subscribed', stream });
        that.dispatchEvent(evt2);
      };
    };

    // Once we have connected
    that.socket = io.connect(token.host, { reconnect: false,
      secure: token.secure,
      'force new connection': true,
      transports: ['websocket'] });

    // We receive an event with a new stream in the room.
    // type can be "media" or "data"
    that.socket.on('onAddStream', (arg) => {
      const stream = Erizo.Stream({ streamID: arg.id,
        local: false,
        audio: arg.audio,
        video: arg.video,
        data: arg.data,
        screen: arg.screen,
        attributes: arg.attributes });
      stream.room = that;
      that.remoteStreams[arg.id] = stream;
      const evt = Erizo.StreamEvent({ type: 'stream-added', stream });
      that.dispatchEvent(evt);
    });

    that.socket.on('signaling_message_erizo', (arg) => {
      let stream;
      if (arg.peerId) {
        stream = that.remoteStreams[arg.peerId];
      } else {
        stream = that.localStreams[arg.streamId];
      }

      if (stream && !stream.failed) {
        stream.pc.processSignalingMessage(arg.mess);
      }
    });

    that.socket.on('signaling_message_peer', (arg) => {
      let stream = that.localStreams[arg.streamId];

      if (stream && !stream.failed) {
        stream.pc[arg.peerSocket].processSignalingMessage(arg.msg);
      } else {
        stream = that.remoteStreams[arg.streamId];

        if (!stream.pc) {
          createRemotePc(stream, arg.peerSocket);
        }
        stream.pc.processSignalingMessage(arg.msg);
      }
    });

    that.socket.on('publish_me', (arg) => {
      const myStream = that.localStreams[arg.streamId];

      if (myStream.pc === undefined) {
        myStream.pc = {};
      }

      myStream.pc[arg.peerSocket] = Erizo.Connection({ callback(msg) {
        sendSDPSocket('signaling_message', { streamId: arg.streamId,
          peerSocket: arg.peerSocket,
          msg });
      },
        audio: myStream.hasAudio(),
        video: myStream.hasVideo(),
        iceServers: that.iceServers });


      myStream.pc[arg.peerSocket].oniceconnectionstatechange = (state) => {
        if (state === 'failed') {
          myStream.pc[arg.peerSocket].close();
          delete myStream.pc[arg.peerSocket];
        } else if (state === 'disconnected') {
          // TODO handle behaviour. Myabe implement Ice-Restart mechanism
        }
      };

      myStream.pc[arg.peerSocket].addStream(myStream.stream);
      myStream.pc[arg.peerSocket].createOffer();
    });

    that.socket.on('onBandwidthAlert', (arg) => {
      L.Logger.info('Bandwidth Alert on', arg.streamID, 'message',
                          arg.message, 'BW:', arg.bandwidth);
      if (arg.streamID) {
        const stream = that.remoteStreams[arg.streamID];
        if (stream && !stream.failed) {
          const evt = Erizo.StreamEvent({ type: 'bandwidth-alert',
            stream,
            msg: arg.message,
            bandwidth: arg.bandwidth });
          stream.dispatchEvent(evt);
        }
      }
    });

    // We receive an event of new data in one of the streams
    that.socket.on('onDataStream', (arg) => {
      const stream = that.remoteStreams[arg.id];
      const evt = Erizo.StreamEvent({ type: 'stream-data', msg: arg.msg, stream });
      stream.dispatchEvent(evt);
    });

    // We receive an event of new data in one of the streams
    that.socket.on('onUpdateAttributeStream', (arg) => {
      const stream = that.remoteStreams[arg.id];
      const evt = Erizo.StreamEvent({ type: 'stream-attributes-update',
        attrs: arg.attrs,
        stream });
      stream.updateLocalAttributes(arg.attrs);
      stream.dispatchEvent(evt);
    });

    // We receive an event of a stream removed from the room
    that.socket.on('onRemoveStream', (arg) => {
      let stream = that.localStreams[arg.id];
      if (stream && !stream.failed) {
        stream.failed = true;
        L.Logger.warning('We received a removeStream from our own stream --' +
                                 ' probably erizoJS timed out');
        const disconnectEvt = Erizo.StreamEvent({ type: 'stream-failed',
          msg: 'Publishing local stream failed because of an Erizo Error',
          stream });
        that.dispatchEvent(disconnectEvt);
        that.unpublish(stream);

        return;
      }
      stream = that.remoteStreams[arg.id];

      if (stream && stream.failed) {
        L.Logger.debug('Received onRemoveStream for a stream ' +
                'that we already marked as failed ', arg.id);
        return;
      } else if (!stream) {
        L.Logger.debug('Received a removeStream for', arg.id,
                               'and it has not been registered here, ignoring.');
        return;
      }
      delete that.remoteStreams[arg.id];
      removeStream(stream);
      const evt = Erizo.StreamEvent({ type: 'stream-removed', stream });
      that.dispatchEvent(evt);
    });

    // The socket has disconnected
    that.socket.on('disconnect', () => {
      L.Logger.info('Socket disconnected, lost connection to ErizoController');
      if (that.state !== DISCONNECTED) {
        L.Logger.error('Unexpected disconnection from ErizoController');
        const disconnectEvt = Erizo.RoomEvent({ type: 'room-disconnected',
          message: 'unexpected-disconnection' });
        that.dispatchEvent(disconnectEvt);
      }
    });

    that.socket.on('connection_failed', (arg) => {
      let stream;
      let disconnectEvt;
      if (arg.type === 'publish') {
        L.Logger.error('ICE Connection Failed on publishing stream',
                                arg.streamId, that.state);
        if (that.state !== DISCONNECTED) {
          if (arg.streamId) {
            stream = that.localStreams[arg.streamId];
            if (stream && !stream.failed) {
              stream.failed = true;
              disconnectEvt = Erizo.StreamEvent({ type: 'stream-failed',
                msg: 'Publishing local stream failed ICE Checks',
                stream });
              that.dispatchEvent(disconnectEvt);
              that.unpublish(stream);
            }
          }
        }
      } else {
        L.Logger.error('ICE Connection Failed on subscribe stream', arg.streamId);
        if (that.state !== DISCONNECTED) {
          if (arg.streamId) {
            stream = that.remoteStreams[arg.streamId];
            if (stream && !stream.failed) {
              stream.failed = true;
              disconnectEvt = Erizo.StreamEvent({ type: 'stream-failed',
                msg: 'Subscriber failed ICE, cannot reach Licode for media',
                stream });
              that.dispatchEvent(disconnectEvt);
              that.unsubscribe(stream);
            }
          }
        }
      }
    });

    that.socket.on('error', (e) => {
      L.Logger.error('Cannot connect to erizo Controller');
      if (error) error('Cannot connect to ErizoController (socket.io error)', e);
    });

    // First message with the token
    sendMessageSocket('token', token, callback, error);
  };

  // Public functions

  // It stablishes a connection to the room.
  // Once it is done it throws a RoomEvent("room-connected")
  that.connect = () => {
    const token = L.Base64.decodeBase64(spec.token);

    if (that.state !== DISCONNECTED) {
      L.Logger.warning('Room already connected');
    }

        // 1- Connect to Erizo-Controller
    that.state = CONNECTING;
    connectSocket(JSON.parse(token), (response) => {
      let stream;
      const streamList = [];
      const streams = response.streams || [];
      const roomId = response.id;

      that.p2p = response.p2p;
      that.iceServers = response.iceServers;
      that.state = CONNECTED;
      spec.defaultVideoBW = response.defaultVideoBW;
      spec.maxVideoBW = response.maxVideoBW;

      // 2- Retrieve list of streams
      const streamIndices = Object.keys(streams);
      for (let index = 0; index < streamIndices.length; index += 1) {
        const arg = streams[streamIndices[index]];
        stream = Erizo.Stream({ streamID: arg.id,
          local: false,
          audio: arg.audio,
          video: arg.video,
          data: arg.data,
          screen: arg.screen,
          attributes: arg.attributes });
        streamList.push(stream);
        that.remoteStreams[arg.id] = stream;
      }

      // 3 - Update RoomID
      that.roomID = roomId;

      L.Logger.info(`Connected to room ${that.roomID}`);

      const connectEvt = Erizo.RoomEvent({ type: 'room-connected', streams: streamList });
      that.dispatchEvent(connectEvt);
    }, (error) => {
      L.Logger.error(`Not Connected! Error: ${error}`);
      const connectEvt = Erizo.RoomEvent({ type: 'room-error', message: error });
      that.dispatchEvent(connectEvt);
    });
  };

  // It disconnects from the room, dispatching a new RoomEvent("room-disconnected")
  that.disconnect = () => {
    L.Logger.debug('Disconnection requested');
    // 1- Disconnect from room
    const disconnectEvt = Erizo.RoomEvent({ type: 'room-disconnected',
      message: 'expected-disconnection' });
    that.dispatchEvent(disconnectEvt);
  };

  // It publishes the stream provided as argument. Once it is added it throws a
  // StreamEvent("stream-added").
  that.publish = (streamInput, optionsInput, callback) => {
    const stream = streamInput;
    const options = optionsInput || {};

    options.maxVideoBW = options.maxVideoBW || spec.defaultVideoBW;
    if (options.maxVideoBW > spec.maxVideoBW) {
      options.maxVideoBW = spec.maxVideoBW;
    }

    if (options.minVideoBW === undefined) {
      options.minVideoBW = 0;
    }

    if (options.minVideoBW > spec.defaultVideoBW) {
      options.minVideoBW = spec.defaultVideoBW;
    }

    options.simulcast = options.simulcast || false;

    // 1- If the stream is not local or it is a failed stream we do nothing.
    if (stream && stream.local && !stream.failed &&
            that.localStreams[stream.getID()] === undefined) {
      // 2- Publish Media Stream to Erizo-Controller
      if (stream.hasAudio() || stream.hasVideo() || stream.hasScreen()) {
        if (stream.url !== undefined || stream.recording !== undefined) {
          let type;
          let arg;
          if (stream.url) {
            type = 'url';
            arg = stream.url;
          } else {
            type = 'recording';
            arg = stream.recording;
          }
          L.Logger.info('Checking publish options for', stream.getID());
          stream.checkOptions(options);
          sendSDPSocket('publish', { state: type,
            data: stream.hasData(),
            audio: stream.hasAudio(),
            video: stream.hasVideo(),
            attributes: stream.getAttributes(),
            metadata: options.metadata,
            createOffer: options.createOffer },
              arg, (id, error) => {
                if (id !== null) {
                  L.Logger.info('Stream published');
                  stream.getID = () => id;
                  stream.sendData = (msg) => {
                    sendDataSocket(stream, msg);
                  };
                  stream.setAttributes = (attrs) => {
                    updateAttributes(stream, attrs);
                  };
                  that.localStreams[id] = stream;
                  stream.room = that;
                  if (callback) { callback(id); }
                } else {
                  L.Logger.error('Error when publishing stream', error);
                  // Unauth -1052488119
                  // Network -5
                  if (callback) { callback(undefined, error); }
                }
              });
        } else if (that.p2p) {
                    // We save them now to be used when actually publishing in P2P mode.
          spec.maxAudioBW = options.maxAudioBW;
          spec.maxVideoBW = options.maxVideoBW;
          sendSDPSocket('publish', { state: 'p2p',
            data: stream.hasData(),
            audio: stream.hasAudio(),
            video: stream.hasVideo(),
            screen: stream.hasScreen(),
            metadata: options.metadata,
            attributes: stream.getAttributes() },
                                  undefined, (id, error) => {
                                    if (id === null) {
                                      L.Logger.error('Error when publishing the stream', error);
                                      if (callback) { callback(undefined, error); }
                                    }
                                    L.Logger.info('Stream published');
                                    stream.getID = () => id;
                                    if (stream.hasData()) {
                                      stream.sendData = (msg) => {
                                        sendDataSocket(stream, msg);
                                      };
                                    }
                                    stream.setAttributes = (attrs) => {
                                      updateAttributes(stream, attrs);
                                    };

                                    that.localStreams[id] = stream;
                                    stream.room = that;
                                  });
        } else {
          L.Logger.info('Publishing to Erizo Normally, is createOffer',
                                  options.createOffer);
          sendSDPSocket('publish', { state: 'erizo',
            data: stream.hasData(),
            audio: stream.hasAudio(),
            video: stream.hasVideo(),
            screen: stream.hasScreen(),
            minVideoBW: options.minVideoBW,
            attributes: stream.getAttributes(),
            createOffer: options.createOffer,
            metadata: options.metadata,
            scheme: options.scheme },
                                  undefined, (id, error) => {
                                    if (id === null) {
                                      L.Logger.error('Error when publishing the stream: ', error);
                                      if (callback) callback(undefined, error);
                                      return;
                                    }

                                    L.Logger.info('Stream assigned an Id, starting the publish process');
                                    stream.getID = () => id;
                                    if (stream.hasData()) {
                                      stream.sendData = (msg) => {
                                        sendDataSocket(stream, msg);
                                      };
                                    }
                                    stream.setAttributes = (attrs) => {
                                      updateAttributes(stream, attrs);
                                    };
                                    that.localStreams[id] = stream;
                                    stream.room = that;

                                    stream.pc = Erizo.Connection({ callback(message) {
                                      L.Logger.debug('Sending message', message);
                                      sendSDPSocket('signaling_message', { streamId: stream.getID(),
                                        msg: message },
                                              undefined, () => {});
                                    },
                                      iceServers: that.iceServers,
                                      maxAudioBW: options.maxAudioBW,
                                      maxVideoBW: options.maxVideoBW,
                                      limitMaxAudioBW: spec.maxAudioBW,
                                      limitMaxVideoBW: spec.maxVideoBW,
                                      simulcast: options.simulcast,
                                      audio: stream.hasAudio(),
                                      video: stream.hasVideo() });

                                    stream.pc.addStream(stream.stream);
                                    stream.pc.oniceconnectionstatechange = (state) => {
                                      // No one is notifying the other subscribers that this is a
                                      // failure they will only receive onRemoveStream
                                      if (state === 'failed') {
                                        if (that.state !== DISCONNECTED &&
                                            stream &&
                                            !stream.failed) {
                                          stream.failed = true;
                                          L.Logger.warning('Publishing Stream',
                                                         stream.getID(),
                                                         'has failed after successful ICE checks');
                                          const disconnectEvt = Erizo.StreamEvent({
                                            type: 'stream-failed',
                                            msg: 'Publishing stream failed after connection',
                                            stream });
                                          that.dispatchEvent(disconnectEvt);
                                          that.unpublish(stream);
                                        }
                                      }
                                    };
                                    if (!options.createOffer) { stream.pc.createOffer(); }
                                    if (callback) callback(id);
                                  });
        }
      } else if (stream.hasData()) {
                // 3- Publish Data Stream
        sendSDPSocket('publish', { state: 'data',
          data: stream.hasData(),
          audio: false,
          video: false,
          screen: false,
          metadata: options.metadata,
          attributes: stream.getAttributes() },
                              undefined,
                              (id, error) => {
                                if (id === null) {
                                  L.Logger.error('Error publishing stream ', error);
                                  if (callback) { callback(undefined, error); }
                                  return;
                                }
                                L.Logger.info('Stream published');
                                stream.getID = () => id;
                                stream.sendData = (msg) => {
                                  sendDataSocket(stream, msg);
                                };
                                stream.setAttributes = (attrs) => {
                                  updateAttributes(stream, attrs);
                                };
                                that.localStreams[id] = stream;
                                stream.room = that;
                                if (callback) callback(id);
                              });
      }
    } else {
      L.Logger.error('Trying to publish invalid stream');
      if (callback) callback(undefined, 'Invalid Stream');
    }
  };

  // Returns callback(id, error)
  that.startRecording = (stream, callback) => {
    if (stream) {
      L.Logger.debug(`Start Recording stream: ${stream.getID()}`);
      sendMessageSocket('startRecorder', { to: stream.getID() }, (id, error) => {
        if (id === null) {
          L.Logger.error('Error on start recording', error);
          if (callback) callback(undefined, error);
          return;
        }

        L.Logger.info('Start recording', id);
        if (callback) callback(id);
      });
    } else {
      L.Logger.error('Trying to start recording on an invalid stream', stream);
      if (callback) callback(undefined, 'Invalid Stream');
    }
  };

  // Returns callback(id, error)
  that.stopRecording = (recordingId, callback) => {
    sendMessageSocket('stopRecorder', { id: recordingId }, (result, error) => {
      if (result === null) {
        L.Logger.error('Error on stop recording', error);
        if (callback) callback(undefined, error);
        return;
      }
      L.Logger.info('Stop recording', recordingId);
      if (callback) callback(true);
    });
  };

  // It unpublishes the local stream in the room, dispatching a StreamEvent("stream-removed")
  that.unpublish = (streamInput, callback) => {
    const stream = streamInput;
    // Unpublish stream from Erizo-Controller
    if (stream && stream.local) {
      // Media stream
      sendMessageSocket('unpublish', stream.getID(), (result, error) => {
        if (result === null) {
          L.Logger.error('Error unpublishing stream', error);
          if (callback) callback(undefined, error);
          return;
        }

        // remove stream failed property since the stream has been
        // correctly removed from licode so is eligible to be
        // published again
        if (stream.failed) {
          delete stream.failed;
        }

        L.Logger.info('Stream unpublished');
        if (callback) callback(true);
      });
      const p2p = stream.room && stream.room.p2p;
      stream.room = undefined;
      if ((stream.hasAudio() ||
                 stream.hasVideo() ||
                 stream.hasScreen()) &&
               stream.url === undefined) {
        if (!p2p) {
          if (stream.pc) stream.pc.close();
          stream.pc = undefined;
        } else {
          for (let index = 0; index <= stream.pc.length; index += 1) {
            stream.pc[index].close();
            stream.pc[index] = undefined;
          }
        }
      }
      delete that.localStreams[stream.getID()];

      stream.getID = () => {};
      stream.sendData = () => {};
      stream.setAttributes = () => {};
    } else {
      const error = 'Cannot unpublish, stream does not exist or is not local';
      L.Logger.error();
      if (callback) callback(undefined, error);
    }
  };

  that.sendControlMessage = (stream, type, action) => {
    if (stream && stream.getID()) {
      const msg = { type: 'control', action };
      sendSDPSocket('signaling_message', { streamId: stream.getID(), msg });
    }
  };

  // It subscribe to a remote stream and draws it inside the HTML tag given by the ID='elementID'
  that.subscribe = (streamInput, optionsInput, callback) => {
    const stream = streamInput;
    const options = optionsInput || {};

    if (stream && !stream.local && !stream.failed) {
      if (stream.hasVideo() || stream.hasAudio() || stream.hasScreen()) {
        // 1- Subscribe to Stream
        if (!stream.hasVideo() && !stream.hasScreen()) options.video = false;
        if (!stream.hasAudio()) options.audio = false;

        if (that.p2p) {
          sendSDPSocket('subscribe', { streamId: stream.getID(),
            metadata: options.metadata });
          if (callback) callback(true);
        } else {
          options.maxVideoBW = options.maxVideoBW || spec.defaultVideoBW;
          if (options.maxVideoBW > spec.maxVideoBW) {
            options.maxVideoBW = spec.maxVideoBW;
          }
          L.Logger.info('Checking subscribe options for', stream.getID());
          stream.checkOptions(options);
          sendSDPSocket('subscribe', { streamId: stream.getID(),
            audio: options.audio,
            video: options.video,
            data: options.data,
            browser: Erizo.getBrowser(),
            createOffer: options.createOffer,
            metadata: options.metadata,
            slideShowMode: options.slideShowMode },
                                  undefined, (result, error) => {
                                    if (result === null) {
                                      L.Logger.error('Error subscribing to stream ', error);
                                      if (callback) { callback(undefined, error); }
                                      return;
                                    }

                                    L.Logger.info('Subscriber added');

                                    stream.pc = Erizo.Connection({
                                      callback(message) {
                                        L.Logger.info('Sending message', message);
                                        sendSDPSocket('signaling_message', { streamId: stream.getID(),
                                          msg: message,
                                          browser: stream.pc.browser },
                                                undefined, () => {});
                                      },
                                      nop2p: true,
                                      audio: options.audio,
                                      video: options.video,
                                      maxAudioBW: spec.maxAudioBW,
                                      maxVideoBW: spec.maxVideoBW,
                                      limitMaxAudioBW: spec.maxAudioBW,
                                      limitMaxVideoBW: spec.maxVideoBW,
                                      iceServers: that.iceServers });

                                    stream.pc.onaddstream = (evt) => {
                                      // Draw on html
                                      L.Logger.info('Stream subscribed');
                                      stream.stream = evt.stream;
                                      const evt2 = Erizo.StreamEvent({ type: 'stream-subscribed',
                                        stream });
                                      that.dispatchEvent(evt2);
                                    };

                                    stream.pc.oniceconnectionstatechange = (state) => {
                                      if (state === 'failed') {
                                        if (that.state !== DISCONNECTED &&
                                            stream &&
                                            !stream.failed) {
                                          stream.failed = true;
                                          L.Logger.warning('Subscribing stream',
                                                        stream.getID(),
                                                        'has failed after successful ICE checks');
                                          const disconnectEvt = Erizo.StreamEvent(
                                            { type: 'stream-failed',
                                              msg: 'Subscribing stream failed after connection',
                                              stream });
                                          that.dispatchEvent(disconnectEvt);
                                          that.unsubscribe(stream);
                                        }
                                      }
                                    };

                                    stream.pc.createOffer(true);
                                    if (callback) callback(true);
                                  });
        }
      } else if (stream.hasData() && options.data !== false) {
        sendSDPSocket('subscribe',
          { streamId: stream.getID(),
            data: options.data,
            metadata: options.metadata },
                              undefined, (result, error) => {
                                if (result === null) {
                                  L.Logger.error('Error subscribing to stream ', error);
                                  if (callback) { callback(undefined, error); }
                                  return;
                                }
                                L.Logger.info('Stream subscribed');
                                const evt = Erizo.StreamEvent({ type: 'stream-subscribed', stream });
                                that.dispatchEvent(evt);
                                if (callback) callback(true);
                              });
      } else {
        L.Logger.warning('There\'s nothing to subscribe to');
        if (callback) callback(undefined, 'Nothing to subscribe to');
        return;
      }
      // Subscribe to stream stream
      L.Logger.info(`Subscribing to: ${stream.getID()}`);
    } else {
      let error = 'Error on subscribe';
      if (!stream) {
        L.Logger.warning('Cannot subscribe to invalid stream', stream);
        error = 'Invalid or undefined stream';
      } else if (stream.local) {
        L.Logger.warning('Cannot subscribe to local stream, you should ' +
                                 'subscribe to the remote version of your local stream');
        error = 'Local copy of stream';
      } else if (stream.failed) {
        L.Logger.warning('Cannot subscribe to failed stream, you should ' +
                                 'wait a new stream-added event.');
        error = 'Failed stream';
      }
      if (callback) { callback(undefined, error); }
    }
  };

  // It unsubscribes from the stream, removing the HTML element.
  that.unsubscribe = (stream, callback) => {
    // Unsubscribe from stream stream
    if (that.socket !== undefined) {
      if (stream && !stream.local) {
        sendMessageSocket('unsubscribe', stream.getID(), (result, error) => {
          if (result === null) {
            if (callback) { callback(undefined, error); }
            return;
          }
          removeStream(stream);
          if (callback) callback(true);
        }, () => {
          L.Logger.error('Error calling unsubscribe.');
        });
      }
    }
  };

  that.getStreamStats = (stream, callback) => {
    if (!that.socket) {
      return 'Error getting stats - no socket';
    }
    if (!stream) {
      return 'Error getting stats - no stream';
    }

    sendMessageSocket('getStreamStats', stream.getID(), (result) => {
      if (result) {
        callback(result);
      }
    });
    return undefined;
  };

  // It searchs the streams that have "name" attribute with "value" value
  that.getStreamsByAttribute = (name, value) => {
    const streams = [];

    for (let index = 0; index <= that.remoteStreams.length; index += 1) {
      const stream = that.remoteStreams[index];

      if (stream.getAttributes() !== undefined &&
                  stream.getAttributes()[name] !== undefined) {
        if (stream.getAttributes()[name] === value) {
          streams.push(stream);
        }
      }
    }

    return streams;
  };


  that.addEventListener('room-disconnected', () => {
    that.state = DISCONNECTED;

    // Remove all streams
    let streamIndices = Object.keys(that.remoteStreams);
    for (let index = 0; index < streamIndices.length; index += 1) {
      const stream = that.remoteStreams[streamIndices[index]];
      removeStream(stream);
      delete that.remoteStreams[stream.getID()];
      if (stream && !stream.failed) {
        const evt2 = Erizo.StreamEvent({ type: 'stream-removed', stream });
        that.dispatchEvent(evt2);
      }
    }
    that.remoteStreams = {};

    // Close Peer Connections
    streamIndices = Object.keys(that.localStreams);
    for (let index = 0; index < streamIndices.length; index += 1) {
      const stream = that.localStreams[streamIndices[index]];
      if (that.p2p) {
        for (let j = 0; j < stream.pc.length; j += 1) {
          stream.pc[j].close();
        }
      } else {
        stream.pc.close();
      }
      delete that.localStreams[stream.getID()];
    }

    // Close socket
    try {
      that.socket.disconnect();
    } catch (error) {
      L.Logger.debug('Socket already disconnected');
    }
    that.socket = undefined;
  });

  return that;
};
