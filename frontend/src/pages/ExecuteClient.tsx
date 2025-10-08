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

const ExecuteClient: React.FC = () => {
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

  // start PSI (matches psi_client.js startPSI function)
  const startPSI = (sessionId: string): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      const peer = new (window as any).Peer({
        host: '/',
        path: '/peerjs/',
        port: 3000,
        debug: 2
      });

      peer.on('open', async function (id: string) {
        console.log(`peer id identified as: ${id}; sending to server`);
        addMessageToList(`peer id identified as: ${id}; sending to server`);

        try {
          const response = await fetch('/client/peerId', {
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json'
            },
            method: 'POST',
            body: JSON.stringify({
              sessionId: sessionId,
              invitedPeerId: id
            })
          });

          if (!response.ok) {
            const responseText = await response.text();
            throw new Error(
              `Response status: ${response.status}, text: ${responseText}`
            );
          }

          console.log('Peer ID sent successfully, connection listener ready');
          addMessageToList(
            'Peer ID sent successfully, connection listener ready'
          );

          // Send ready signal to server
          try {
            const readyResponse = await fetch('/client/ready', {
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
              },
              method: 'POST',
              body: JSON.stringify({
                sessionId: sessionId,
                clientReady: true
              })
            });

            if (readyResponse.ok) {
              console.log('Ready signal sent to server');
              addMessageToList('Ready signal sent to server');
            }
          } catch (error) {
            console.error('Error sending ready signal:', error);
          }
        } catch (error) {
          console.error(error.message);
          addMessageToList('Error sending peer ID: ' + error.message);
          reject(error);
          return;
        }
      });

      peer.on('connection', function (conn: any) {
        console.log('connection event received from server');
        addMessageToList('connection event received from server');
        console.log('loading PSI');
        addMessageToList('loading PSI');

        (window as any).PSI().then((psi: any) => {
          console.log('PSI loaded');
          addMessageToList('PSI loaded');

          const client = psi.client.createWithNewKey(true);
          let localServerSetup: any = null;

          conn
            .on('open', function () {
              console.log('connection open');
              addMessageToList('connection open');
            })
            .on('data', function (data: any) {
              if (localServerSetup === null) {
                console.log('disconnecting from peer server');
                peer.disconnect();
                console.log('received setup message; sending request');
                addMessageToList('received setup message; sending request');

                localServerSetup = psi.serverSetup.deserializeBinary(data);
                const storedData = sessionStorage.getItem(
                  `psi_data_${sessionId}`
                );
                console.log('Stored client data:', storedData);

                if (!storedData) {
                  throw new Error('No client data found in sessionStorage');
                }

                const parsedData = JSON.parse(storedData);
                const clientData = parsedData.data;

                console.log('Client data for PSI:', clientData);

                if (!clientData || !Array.isArray(clientData)) {
                  throw new Error('Invalid client data format');
                }

                const clientRequest = client.createRequest(clientData);
                conn.send(clientRequest.serializeBinary());
              } else {
                console.log(
                  'received response message; calculating intersection'
                );
                addMessageToList(
                  'received response message; calculating intersection'
                );

                const serverResponse = psi.response.deserializeBinary(data);
                const associationTable = client.getAssociationTable(
                  localServerSetup,
                  serverResponse
                );
                console.log(
                  'associations (to server sorted elements) are: ',
                  associationTable
                );
                addMessageToList('associations calculated');

                var commonValues: string[] = [];
                const storedData = sessionStorage.getItem(
                  `psi_data_${sessionId}`
                );
                const parsedData = JSON.parse(storedData!);
                const clientData = parsedData.data;
                for (var i = 0; i < associationTable[0].length; i++) {
                  commonValues.push(clientData[associationTable[0][i]]);
                }
                console.log('common values: ', commonValues);
                addMessageToList('common values: ' + commonValues);
                conn.close();
                resolve(commonValues);
              }
            });
        });
      });

      peer.on('error', function (err: any) {
        console.error('peer error ' + err);
        addMessageToList('peer error ' + err);
        reject(new Error(`Peer error: ${err}`));
      });
    });
  };

  const startExecution = async () => {
    setProgress(0);
    setMessages([]);
    const startTime = Date.now();

    try {
      setProgressStep('Connecting to server...');
      setProgress(40);

      // Execute PSI protocol
      const result = await startPSI(sessionId!);
      setResults(result);
      setProgressStep('PSI complete');
      setProgress(100);
      setExecutionTime(Date.now() - startTime);

      toast({
        title: 'PSI Complete!',
        description: `Found ${result.length} overlapping items.`
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
              <span className="ml-4 px-3 py-1 bg-blue-200 text-blue-800 rounded-full text-xs font-bold">
                CLIENT
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
              Client-side execution for session: {sessionInfo.sessionName}
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
                  className="w-full bg-blue-600 hover:bg-blue-700"
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

          {/* What Happens Next */}
          {/* <Card className="mt-8 animate-fade-in bg-blue-50 border-blue-200">
            <CardContent className="pt-6">
              <div className="text-center">
                <h3 className="font-semibold text-blue-900 mb-2">
                  What happens next?
                </h3>
                <p className="text-sm text-blue-800 mb-4">
                  The PSI algorithm will securely compute the intersection of
                  both datasets without revealing any information beyond the
                  common items.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-blue-700">
                  <div className="text-center">
                    <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center mx-auto mb-2">
                      1
                    </div>
                    <p>Secure connection established</p>
                  </div>
                  <div className="text-center">
                    <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center mx-auto mb-2">
                      2
                    </div>
                    <p>Cryptographic computation</p>
                  </div>
                  <div className="text-center">
                    <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center mx-auto mb-2">
                      3
                    </div>
                    <p>Results revealed</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card> */}

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

export default ExecuteClient;
