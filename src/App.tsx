/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef, useCallback, Component, ReactNode } from 'react';
import { 
  signInWithPopup, 
  onAuthStateChanged, 
  signOut, 
  User as FirebaseUser,
  browserPopupRedirectResolver
} from 'firebase/auth';
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  onSnapshot, 
  addDoc, 
  query, 
  where, 
  deleteDoc,
  serverTimestamp,
  updateDoc,
  getDocs
} from 'firebase/firestore';
import { Peer, MediaConnection } from 'peerjs';
import { 
  Video, 
  VideoOff, 
  Mic, 
  MicOff, 
  PhoneOff, 
  Copy, 
  Users, 
  Plus, 
  LogIn, 
  LogOut,
  Shield,
  Monitor,
  Settings,
  MoreVertical
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, googleProvider } from './firebase';
import { cn } from './lib/utils';

// --- Types ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Participant {
  id: string;
  userId: string;
  peerId: string;
  name: string;
  photoURL: string;
  isMuted: boolean;
  isVideoOff: boolean;
  joinedAt: any;
}

interface Room {
  id: string;
  name: string;
  hostId: string;
  createdAt: any;
}

// --- Components ---

const Button = ({ 
  children, 
  onClick, 
  variant = 'primary', 
  className,
  disabled = false
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  className?: string;
  disabled?: boolean;
}) => {
  const variants = {
    primary: 'bg-white text-black hover:bg-neutral-200',
    secondary: 'bg-neutral-800 text-white hover:bg-neutral-700 border border-neutral-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'bg-transparent text-neutral-400 hover:text-white hover:bg-white/5'
  };

  return (
    <button 
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-4 py-2 rounded-full font-medium transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        className
      )}
    >
      {children}
    </button>
  );
};

const VideoTile = ({ 
  stream, 
  participant, 
  isLocal = false 
}: { 
  stream: MediaStream | null; 
  participant: Participant;
  isLocal?: boolean;
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="relative aspect-video bg-neutral-900 rounded-2xl overflow-hidden border border-white/5 group shadow-2xl">
      {participant.isVideoOff ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center border border-white/10 overflow-hidden">
             {participant.photoURL ? (
               <img src={participant.photoURL} alt={participant.name} className="w-full h-full object-cover" />
             ) : (
               <span className="text-2xl font-bold text-neutral-500">{participant.name[0]}</span>
             )}
          </div>
        </div>
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={cn(
            "w-full h-full object-cover",
            isLocal && "scale-x-[-1]"
          )}
        />
      )}
      
      <div className="absolute bottom-4 left-4 flex items-center gap-2 px-3 py-1.5 bg-black/40 backdrop-blur-md rounded-lg border border-white/10">
        <span className="text-xs font-medium text-white/90">
          {participant.name} {isLocal && "(You)"}
        </span>
        {participant.isMuted && <MicOff className="w-3 h-3 text-red-500" />}
      </div>

      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className="p-2 bg-black/40 backdrop-blur-md rounded-full border border-white/10 text-white/70 hover:text-white">
          <MoreVertical className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [isPeerConnected, setIsPeerConnected] = useState(false);
  const [peerError, setPeerError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [localParticipant, setLocalParticipant] = useState<Participant | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const callsRef = useRef<Record<string, MediaConnection>>({});
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // --- Auth ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (u) {
        setUser(u);
        // Sync user to Firestore
        try {
          await setDoc(doc(db, 'users', u.uid), {
            name: u.displayName,
            email: u.email,
            photoURL: u.photoURL,
            lastActive: serverTimestamp()
          }, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${u.uid}`);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // --- PeerJS & Connection Management ---
  useEffect(() => {
    if (!room || !user || !localStream) return;

    console.log("Initializing PeerJS (retryCount: " + retryCount + ")...");
    setPeerError(null);
    setIsPeerConnected(false);

    const peer = new Peer({
      debug: 3,
      config: {
        'iceServers': [
          { 'urls': 'stun:stun.l.google.com:19302' },
          { 'urls': 'stun:stun1.l.google.com:19302' },
          { 'urls': 'stun:stun2.l.google.com:19302' },
          { 'urls': 'stun:stun3.l.google.com:19302' },
          { 'urls': 'stun:stun4.l.google.com:19302' },
        ]
      }
    });
    peerRef.current = peer;

    const peerTimeout = setTimeout(() => {
      if (!peer.open && !peer.destroyed) {
        console.error("PeerJS connection timeout");
        setPeerError("Connection timeout. PeerJS signaling might be blocked by your network or firewall.");
      }
    }, 30000);

    peer.on('open', async (id) => {
      clearTimeout(peerTimeout);
      console.log("PeerJS opened with ID:", id);
      setIsPeerConnected(true);
      setPeerError(null);

      const participantRef = doc(db, 'rooms', room.id, 'participants', user.uid);
      try {
        await setDoc(participantRef, {
          userId: user.uid,
          peerId: id,
          name: user.displayName,
          photoURL: user.photoURL,
          isMuted: isMuted,
          isVideoOff: isVideoOff,
          joinedAt: serverTimestamp()
        });
        console.log("Participant registered in Firestore");
      } catch (err) {
        console.error("Error registering participant:", err);
        handleFirestoreError(err, OperationType.WRITE, `rooms/${room.id}/participants/${user.uid}`);
      }
    });

    peer.on('error', (err) => {
      console.error("PeerJS Error:", err);
      setPeerError(`Connection error: ${err.type}. ${err.message || ""}`);
      setIsPeerConnected(false);
    });

    peer.on('call', (call) => {
      console.log(`Receiving call from: ${call.peer}`);
      try {
        call.answer(localStream);
        call.on('stream', (remoteStream) => {
          console.log(`Received stream from caller: ${call.peer}`);
          setRemoteStreams(prev => ({ ...prev, [call.peer]: remoteStream }));
        });
        call.on('error', (err) => {
          console.error(`Call error with ${call.peer}:`, err);
        });
      } catch (err) {
        console.error("Error answering call:", err);
      }
    });

    // Listen for other participants
    const q = collection(db, 'rooms', room.id, 'participants');
    const unsubscribe = onSnapshot(q, (snapshot) => {
      try {
        const parts: Participant[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data() as Participant;
          parts.push({ id: doc.id, ...data });
          
          // Call new participants
          if (peer.open && data.peerId && data.peerId !== peer.id && !callsRef.current[data.peerId]) {
            console.log(`Calling participant: ${data.name} (${data.peerId})`);
            try {
              const call = peer.call(data.peerId, localStream);
              call.on('stream', (remoteStream) => {
                console.log(`Received stream from: ${data.name}`);
                setRemoteStreams(prev => ({ ...prev, [data.peerId]: remoteStream }));
              });
              call.on('error', (err) => {
                console.error(`Call error with ${data.name}:`, err);
              });
              callsRef.current[data.peerId] = call;
            } catch (err) {
              console.error(`Error calling ${data.name}:`, err);
            }
          }
        });
        setParticipants(parts);
      } catch (err) {
        console.error("Error in onSnapshot listener:", err);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, `rooms/${room.id}/participants`);
    });

    return () => {
      console.log("Cleaning up PeerJS connection...");
      clearTimeout(peerTimeout);
      unsubscribe();
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
      // Close all active calls
      (Object.values(callsRef.current) as MediaConnection[]).forEach(call => call.close());
      callsRef.current = {};
      setRemoteStreams({});
      setIsPeerConnected(false);
    };
  }, [room?.id, user?.uid, localStream, retryCount]);

  const login = async () => {
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider, browserPopupRedirectResolver);
    } catch (err: any) {
      console.error("Login Error:", err);
      setError(`Login failed: ${err.message || "Unknown error"}. Please ensure popups are allowed and the domain is authorized in Firebase.`);
    }
  };

  const logout = () => signOut(auth);

  // --- Meeting Logic ---

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (unsubscribeRef.current) unsubscribeRef.current();
      if (peerRef.current) peerRef.current.destroy();
      localStream?.getTracks().forEach(track => track.stop());
    };
  }, [localStream]);

  const startMeeting = async () => {
    if (!user) return;
    setIsJoining(true);
    setError(null);
    const roomId = Math.random().toString(36).substring(2, 10);
    const roomRef = doc(db, 'rooms', roomId);
    try {
      console.log("Creating room:", roomId);
      await setDoc(roomRef, {
        name: `${user.displayName}'s Meeting`,
        hostId: user.uid,
        createdAt: serverTimestamp(),
        active: true
      });
      console.log("Room created successfully");
      await joinRoom(roomId);
    } catch (err) {
      console.error("Error creating room:", err);
      handleFirestoreError(err, OperationType.WRITE, `rooms/${roomId}`);
      setIsJoining(false);
    }
  };

  const joinRoom = async (roomId: string) => {
    if (!user) return;
    setIsJoining(true);
    setError(null);
    setPeerError(null);

    try {
      // 1. Check if room exists
      const roomRef = doc(db, 'rooms', roomId);
      const roomSnap = await getDoc(roomRef);
      
      if (!roomSnap.exists()) {
        setError("Room not found. Please check the ID and try again.");
        setIsJoining(false);
        return;
      }
      const roomData = roomSnap.data() as Room;

      // 2. Get User Media
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError("Your browser does not support video calling. Please use a modern browser like Chrome or Firefox.");
        setIsJoining(false);
        return;
      }

      let stream: MediaStream;
      try {
        console.log("Requesting media access...");
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user"
          }, 
          audio: true 
        });
        console.log("Media access granted");
      } catch (err: any) {
        console.error("Media Access Error:", err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setError("Camera/Microphone access denied. Please allow access to join the meeting.");
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setError("No camera or microphone found.");
        } else {
          setError(`Media Error: ${err.message || "Could not access camera/microphone"}`);
        }
        setIsJoining(false);
        return;
      }
      
      setLocalStream(stream);

      // 3. Set Initial State (The useEffect will handle PeerJS)
      const initialLocalParticipant: Participant = {
        id: user.uid,
        userId: user.uid,
        peerId: '',
        name: user.displayName || 'Anonymous',
        photoURL: user.photoURL || '',
        isMuted: false,
        isVideoOff: false,
        joinedAt: new Date()
      };
      setLocalParticipant(initialLocalParticipant);
      setRoom({ id: roomId, ...roomData });
      setIsJoining(false);

    } catch (err) {
      console.error("General Join Error:", err);
      setError("An unexpected error occurred while joining the room.");
      setIsJoining(false);
    }
  };

  const retryConnection = () => {
    console.log("Retry button clicked, incrementing retryCount...");
    setRetryCount(prev => prev + 1);
  };

  const leaveRoom = async () => {
    if (room && user) {
      console.log("Leaving room...");
      try {
        await deleteDoc(doc(db, 'rooms', room.id, 'participants', user.uid));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `rooms/${room.id}/participants/${user.uid}`);
      }
      
      // Stop all tracks
      localStream?.getTracks().forEach(track => {
        track.stop();
        console.log(`Stopped track: ${track.kind}`);
      });
      setLocalStream(null);
      
      // PeerJS cleanup is handled by useEffect cleanup
      setRoom(null);
      setParticipants([]);
      setRemoteStreams({});
      setLocalParticipant(null);
    }
  };

  const toggleMute = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
      
      if (room && user) {
        try {
          updateDoc(doc(db, 'rooms', room.id, 'participants', user.uid), {
            isMuted: !audioTrack.enabled
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}/participants/${user.uid}`);
        }
      }
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoOff(!videoTrack.enabled);
      
      if (room && user) {
        try {
          updateDoc(doc(db, 'rooms', room.id, 'participants', user.uid), {
            isVideoOff: !videoTrack.enabled
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}/participants/${user.uid}`);
        }
      }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-white/10 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-8"
        >
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center shadow-[0_0_50px_rgba(255,255,255,0.1)]">
              <Video className="w-10 h-10 text-black" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className="text-5xl font-light tracking-tight">Nexus</h1>
            <p className="text-neutral-500 font-light">Premium, private video experiences.</p>
          </div>

          <Button onClick={login} className="w-full py-4 text-lg">
            <LogIn className="w-5 h-5" />
            Connect with Google
          </Button>

          {error && (
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-red-500 text-sm bg-red-500/10 p-4 rounded-xl border border-red-500/20"
            >
              {error}
            </motion.p>
          )}

          <div className="pt-8 border-t border-white/5 flex justify-center gap-8 opacity-40 grayscale">
             <Shield className="w-6 h-6" />
             <Monitor className="w-6 h-6" />
             <Settings className="w-6 h-6" />
          </div>
        </motion.div>
      </div>
    );
  }

  if (room) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex flex-col font-sans">
        {/* Header */}
        <header className="p-4 flex items-center justify-between border-b border-white/5 bg-black/40 backdrop-blur-xl sticky top-0 z-50">
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
              <Video className="w-4 h-4 text-black" />
            </div>
            <div>
              <h2 className="text-sm font-medium">{room.name}</h2>
              <div className="flex items-center gap-2 text-[10px] text-neutral-500 uppercase tracking-widest">
                <span className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse" />
                Live • {participants.length} Participants
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant="secondary" className="h-9 text-xs" onClick={() => {
              navigator.clipboard.writeText(room.id);
              setToast("Room ID copied!");
              setTimeout(() => setToast(null), 3000);
            }}>
              <Copy className="w-3.5 h-3.5" />
              {room.id}
            </Button>
            <Button variant="ghost" className="h-9 w-9 p-0">
              <Users className="w-4 h-4" />
            </Button>
          </div>
        </header>

        {/* Video Grid */}
        <main className="flex-1 p-6 overflow-y-auto relative">
          <div className={cn(
            "grid gap-6 max-w-7xl mx-auto h-full content-center",
            (participants.length + (localParticipant ? 1 : 0)) <= 1 ? "grid-cols-1 max-w-3xl" : 
            (participants.length + (localParticipant ? 1 : 0)) <= 2 ? "grid-cols-1 md:grid-cols-2" :
            (participants.length + (localParticipant ? 1 : 0)) <= 4 ? "grid-cols-2" :
            "grid-cols-2 lg:grid-cols-3"
          )}>
            <AnimatePresence>
              {/* Local Participant */}
              {localParticipant && !participants.find(p => p.userId === user.uid) && (
                <motion.div
                  key="local-temp"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  <VideoTile 
                    participant={localParticipant} 
                    stream={localStream} 
                    isLocal={true}
                  />
                </motion.div>
              )}

              {/* All Participants (including local once synced) */}
              {participants.map((p) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  <VideoTile 
                    participant={p} 
                    stream={p.userId === user.uid ? localStream : remoteStreams[p.peerId]} 
                    isLocal={p.userId === user.uid}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {!isPeerConnected && (
            <div className="fixed bottom-24 right-8 z-50">
              <div className="bg-black/80 backdrop-blur-md border border-white/10 px-4 py-2 rounded-2xl flex flex-col gap-2 shadow-2xl min-w-[200px]">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    <span className="text-[10px] uppercase tracking-widest text-neutral-400">
                      {peerError ? "Connection Failed" : "Connecting..."}
                    </span>
                  </div>
                  <Button 
                    variant="ghost" 
                    className="h-7 px-3 text-[10px] uppercase tracking-widest hover:bg-white/5 text-white"
                    onClick={retryConnection}
                  >
                    Retry
                  </Button>
                </div>
                {peerError && (
                  <p className="text-[9px] text-red-400 leading-tight border-t border-white/5 pt-2">
                    {peerError}
                  </p>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Controls */}
        <footer className="p-6 flex items-center justify-center gap-4 bg-gradient-to-t from-black to-transparent">
          <Button 
            variant="secondary" 
            className={cn("w-14 h-14 rounded-2xl", isMuted && "bg-red-600 border-red-600 text-white")}
            onClick={toggleMute}
          >
            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </Button>
          
          <Button 
            variant="secondary" 
            className={cn("w-14 h-14 rounded-2xl", isVideoOff && "bg-red-600 border-red-600 text-white")}
            onClick={toggleVideo}
          >
            {isVideoOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
          </Button>

          <Button 
            variant="danger" 
            className="w-20 h-14 rounded-2xl"
            onClick={leaveRoom}
          >
            <PhoneOff className="w-6 h-6" />
          </Button>
        </footer>

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="fixed bottom-24 left-1/2 -translate-x-1/2 px-6 py-3 bg-white text-black rounded-full font-medium shadow-2xl z-[100]"
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white flex flex-col font-sans">
      <header className="p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center">
            <Video className="w-6 h-6 text-black" />
          </div>
          <h1 className="text-2xl font-light tracking-tight">Nexus</h1>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium">{user.displayName}</p>
            <p className="text-[10px] text-neutral-500 uppercase tracking-widest">Premium Member</p>
          </div>
          <img src={user.photoURL!} alt="" className="w-10 h-10 rounded-full border border-white/10" />
          <Button variant="ghost" className="p-2" onClick={logout}>
            <LogOut className="w-5 h-5" />
          </Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="max-w-2xl w-full text-center space-y-12">
          <div className="space-y-6">
            <h2 className="text-6xl sm:text-7xl font-light leading-tight tracking-tighter">
              Connect <br />
              <span className="text-neutral-500 italic">Everywhere.</span>
            </h2>
            <p className="text-neutral-400 max-w-md mx-auto leading-relaxed">
              Experience crystal clear video and audio in a private, secure environment designed for professionals.
            </p>
          </div>

          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4 items-stretch justify-center">
              <Button 
                onClick={startMeeting} 
                className="h-16 px-10 text-xl whitespace-nowrap"
                disabled={isJoining}
              >
                {isJoining ? (
                   <div className="w-6 h-6 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                ) : (
                  <>
                    <Plus className="w-6 h-6" />
                    New Meeting
                  </>
                )}
              </Button>
              
              <div className="relative flex gap-2 min-w-[300px]">
                <input 
                  type="text" 
                  placeholder="Enter room code"
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  className="flex-1 h-16 bg-neutral-900 border border-white/10 rounded-2xl px-6 text-white placeholder:text-neutral-600 focus:outline-none focus:border-white/30 transition-colors text-lg"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') joinRoom(roomInput);
                  }}
                />
                <Button 
                  variant="secondary" 
                  className="h-16 px-8 rounded-2xl text-lg"
                  onClick={() => joinRoom(roomInput)}
                  disabled={!roomInput.trim() || isJoining}
                >
                  Join
                </Button>
              </div>
            </div>

            {error && (
              <motion.p 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-red-500 text-sm bg-red-500/10 p-4 rounded-xl border border-red-500/20 max-w-md mx-auto"
              >
                {error}
              </motion.p>
            )}
          </div>
        </div>
      </main>

      <footer className="p-8 border-t border-white/5">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 opacity-40">
          <p className="text-[10px] uppercase tracking-widest">© 2026 Nexus Technologies</p>
          <div className="flex gap-6">
            <a href="#" className="text-[10px] uppercase tracking-widest hover:text-white transition-colors">Privacy</a>
            <a href="#" className="text-[10px] uppercase tracking-widest hover:text-white transition-colors">Terms</a>
            <a href="#" className="text-[10px] uppercase tracking-widest hover:text-white transition-colors">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
