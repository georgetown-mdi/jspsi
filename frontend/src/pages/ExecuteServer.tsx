import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import LoadingSpinner from '@/components/LoadingSpinner';
import {
  Shield,
  ArrowLeft,
  Download,
  Users,
  CheckCircle,
  AlertCircle,
  Play
} from 'lucide-react';

// Global declarations for PeerJS and PSI
declare global {
  interface Window {
    Peer: any;
    PSI: () => Promise<any>;
  }
}

interface SessionInfo {
  sessionId: string;
  sessionName: string;
  initiatedName: string;
  invitedName: string;
  description: string;
  link: string;
}

const ExecuteServer: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [progressStep, setProgressStep] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [executionTime, setExecutionTime] = useState<number | null>(null);

  useEffect(() => {
    fetchSessionInfo();
  }, [sessionId]);

  const fetchSessionInfo = async () => {
    try {
      const res = await fetch(`/api/session/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionInfo(data);
      } else if (res.status === 404) {
        setSessionInfo(null);
      } else {
        console.error('Failed to fetch session:', res.status);
      }
    } catch (error) {
      console.error('Failed to fetch session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const addMessageToList = (message: string) => {
    setMessages((prev) => [...prev, message]);
  };

  // Mirror the Pug server logic: open event stream (matches psi_server.js)
  const openEventStream = (sessionId: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(
        `/server/peerId?sessionId=${sessionId}`
      );

      eventSource.onopen = function () {
        console.log('SSE connection opened; waiting for peer id');
        addMessageToList('SSE connection opened; waiting for peer id');
      };

      eventSource.onmessage = function (message) {
        const messageData = JSON.parse(message.data);
        if (!('invitedPeerId' in messageData)) {
          addMessageToList(
            'received unexpected message from server:' + messageData
          );
          reject(new Error('Unexpected message format'));
        } else {
          const invitedPeerId = messageData['invitedPeerId'];
          console.log(`received peer id ${invitedPeerId}`);
          addMessageToList(`received peer id ${invitedPeerId}`);
          eventSource.close();
          resolve(invitedPeerId);
        }
      };

      eventSource.onerror = function (err) {
        console.error('EventSource failed:', err);
        reject(new Error('SSE connection failed'));
      };
    });
  };

  // Wait for client to be ready
  const waitForClientReady = (sessionId: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const checkReady = async () => {
        try {
          const response = await fetch(`/api/session/${sessionId}`);
          if (response.ok) {
            const sessionData = await response.json();
            if (sessionData.clientReady) {
              console.log('Client is ready');
              addMessageToList('Client is ready');
              resolve();
              return;
            }
          }
          // Check again in 500ms
          setTimeout(checkReady, 500);
        } catch (error) {
          reject(error);
        }
      };
      checkReady();
    });
  };

  // Mirror the Pug server logic: open peer connection (matches psi_server.js)
  const openPeerConnection = (peerId: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      console.log(
        'peer id received and file loaded; opening direct connection'
      );
      addMessageToList(
        'peer id received and file loaded; opening direct connection'
      );

      const peer = new (window as any).Peer({
        host: '/',
        path: '/peerjs/',
        port: 3000,
        debug: 2
      });

      peer.on('open', function (id: string) {
        console.log(`peer id identified as: ${id}`);
        addMessageToList(`peer id identified as: ${id}`);
        console.log('loading PSI');
        addMessageToList('loading PSI');

        (window as any).PSI().then((psi: any) => {
          console.log('PSI loaded');
          addMessageToList('PSI loaded');

          console.log('Attempting to connect to peer ID:', peerId);
          addMessageToList('Attempting to connect to peer ID: ' + peerId);

          const conn = peer.connect(peerId);
          let serverInstance: any;

          conn
            .on('open', function () {
              console.log('peer connection open');
              addMessageToList('peer connection open');

              serverInstance = psi.server.createWithNewKey(true);
              console.log('sending setup message');
              addMessageToList('sending setup message');

              var sortingPermutation: any[] = [];
              const storedData = sessionStorage.getItem(
                `psi_data_${sessionId}`
              );
              console.log('Stored server data:', storedData);

              if (!storedData) {
                throw new Error('No server data found in sessionStorage');
              }

              const parsedData = JSON.parse(storedData);
              const serverData = parsedData.data;

              console.log('Server data for PSI:', serverData);

              if (!serverData || !Array.isArray(serverData)) {
                throw new Error('Invalid server data format');
              }

              const serverSetup = serverInstance.createSetupMessage(
                0.0,
                -1,
                serverData,
                psi.dataStructure.Raw,
                sortingPermutation
              );

              conn.send(serverSetup.serializeBinary());
            })
            .on('data', function (data: any) {
              console.log('received data ', data);
              addMessageToList('received data');

              console.log('disconnecting from peer server');
              peer.disconnect();

              console.log('received request message, sending response');
              addMessageToList('received request message, sending response');

              const clientRequest = psi.request.deserializeBinary(data);
              const serverResponse =
                serverInstance.processRequest(clientRequest);
              conn.send(serverResponse.serializeBinary());
              conn.close();

              resolve([]); // Server doesn't get results
            })
            .on('error', function (err: any) {
              console.error('connection error: ' + err);
              addMessageToList('connection error: ' + err);
              reject(new Error(`Connection error: ${err}`));
            });
        });
      });

      peer.on('error', function (err: any) {
        console.error('peer error: ' + err);
        addMessageToList('peer error: ' + err);
        reject(new Error(`Peer error: ${err}`));
      });
    });
  };

  const startExecution = async () => {
    setProgress(0);
    setMessages([]);
    const startTime = Date.now();

    try {
      setProgressStep('Waiting for client to join...');
      setProgress(20);

      // Wait for invited peer to join
      const peerId = await openEventStream(sessionId!);

      setProgressStep('Waiting for client to be ready...');
      setProgress(40);

      // Wait for client to be ready
      await waitForClientReady(sessionId!);

      setProgressStep('Client ready, opening connection...');
      setProgress(60);

      // Execute PSI protocol
      const result = await openPeerConnection(peerId);
      setResults(result);
      setProgressStep('PSI complete');
      setProgress(100);
      setExecutionTime(Date.now() - startTime);

      toast({
        title: 'PSI Complete!'
      });
    } catch (error) {
      console.error('PSI execution error:', error);
      toast({
        title: 'Execution Failed',
        description: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'destructive'
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
        <div className="flex items-center justify-center min-h-screen">
          <LoadingSpinner className="w-8 h-8" />
        </div>
      </div>
    );
  }

  if (!sessionInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-red-600 mb-4">
              Session Not Found
            </h1>
            <Button
              onClick={() => navigate('/')}
              className="bg-blue-600 hover:bg-blue-700"
            >
              Back to Home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('/')}
                className="mr-2"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-900">PSI Secure</h1>
              <span className="ml-4 px-3 py-1 bg-green-200 text-green-800 rounded-full text-xs font-bold">
                SERVER
              </span>
            </div>
            <div className="text-sm text-gray-600">Session: {sessionId}</div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Play className="w-8 h-8 text-blue-600" />
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Ready to Execute PSI
            </h2>
            <p className="text-lg text-gray-600">
              Server-side execution for session: {sessionInfo.sessionName}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Execution Control */}
            <Card className="animate-fade-in">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Play className="w-5 h-5 mr-2" />
                  Execution Control
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm text-gray-600">Current Step:</p>
                  <p className="font-medium">
                    {progressStep || 'Ready to start'}
                  </p>
                </div>

                <Progress value={progress} className="w-full" />

                <Button
                  onClick={startExecution}
                  className="w-full bg-green-600 hover:bg-green-700"
                  disabled={progress > 0 && progress < 100}
                >
                  Start PSI Execution
                </Button>
              </CardContent>
            </Card>

            {/* Session Info */}
            <Card className="animate-fade-in">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Users className="w-5 h-5 mr-2" />
                  Session Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm text-gray-600">Initiator:</p>
                  <p className="font-medium">{sessionInfo.initiatedName}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Invitee:</p>
                  <p className="font-medium">{sessionInfo.invitedName}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Description:</p>
                  <p className="font-medium">
                    {sessionInfo.description || 'No description'}
                  </p>
                </div>
                {executionTime && (
                  <div>
                    <p className="text-sm text-gray-600">Execution Time:</p>
                    <p className="font-medium">{executionTime}ms</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Messages Log */}
          <Card className="mt-8 animate-fade-in">
            <CardHeader>
              <CardTitle className="flex items-center">
                <AlertCircle className="w-5 h-5 mr-2" />
                Execution Log
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-gray-50 rounded-lg p-4 max-h-64 overflow-y-auto">
                {messages.length === 0 ? (
                  <p className="text-gray-500 text-center">No messages yet</p>
                ) : (
                  <ul className="space-y-1">
                    {messages.map((message, index) => (
                      <li
                        key={index}
                        className="text-sm font-mono text-gray-700"
                      >
                        {message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Results */}
          {results.length > 0 && (
            <Card className="mt-8 animate-fade-in">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <CheckCircle className="w-5 h-5 mr-2" />
                  Results
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-green-50 rounded-lg p-4">
                  <p className="text-green-800 font-medium mb-2">
                    Found {results.length} overlapping items
                  </p>
                  <Button
                    onClick={() => {
                      const blob = new Blob([results.join('\n')], {
                        type: 'text/plain'
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'psi_results.txt';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download Results
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExecuteServer;
