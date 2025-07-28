import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Shield, Copy, CheckCircle, ArrowLeft, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SessionReady = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  // State to hold the invited peer's ID (when it arrives)
  const [invitedPeerId, setInvitedPeerId] = useState<string | null>(null);
  // State to track if we're still waiting for the peer
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    // Fetch session info as before
    const fetchSession = async () => {
      const res = await fetch(`/api/session/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionInfo(data);
        // } else if (res.status === 404) {
        //   // Session not found
        //   setSessionInfo(null);
        // } else {
        //   // Other error
        //   console.error('Failed to fetch session:', res.status);
      }
    };
    fetchSession();

    // --- SSE logic: Wait for the invited peer to join ---
    // Only run if we have a sessionId
    if (sessionId) {
      // Open an SSE connection to the backend
      const es = new EventSource(`/server/peerId?sessionId=${sessionId}`);
      es.onmessage = (event) => {
        // The backend sends the invited peer's ID as JSON
        const data = JSON.parse(event.data);
        setInvitedPeerId(data.invitedPeerId);
        setWaiting(false); // No longer waiting
        es.close(); // Close the SSE connection
      };
      es.onerror = () => {
        // Optionally handle errors (e.g., show a message or retry)
        es.close();
      };
      // Clean up the connection if the component unmounts
      return () => es.close();
    }
  }, [sessionId]);

  const copyLink = async () => {
    // Use the link from backend, or generate one if not available
    const linkToCopy =
      sessionInfo?.link || `http://localhost:8080/join/${sessionId}`;
    await navigator.clipboard.writeText(linkToCopy);
  };

  if (!sessionInfo) {
    return <div className="text-center py-12">Loading session info...</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
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
            </div>
            <div className="text-sm text-gray-600">Session Ready</div>
          </div>
        </div>
      </header>
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="animate-fade-in">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Session Ready!
              </h2>
              <p className="text-lg text-gray-600">
                Share the link below with the other party to begin the PSI
                process
              </p>
            </div>
            <div className="space-y-6">
              <Card className="shadow-lg">
                <CardHeader>
                  <CardTitle>Session Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <Label className="text-sm font-medium text-gray-600">
                        Session Name
                      </Label>
                      <p className="text-lg font-medium text-gray-900">
                        {sessionInfo.sessionName}
                      </p>
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-gray-600">
                        Session ID
                      </Label>
                      <p className="text-sm font-mono text-gray-700 bg-gray-100 px-3 py-2 rounded">
                        {sessionId}
                      </p>
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-gray-600">
                        File Uploaded
                      </Label>
                      <p className="text-sm text-gray-700">
                        (Uploaded by creator)
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-lg border-blue-200">
                <CardHeader>
                  <CardTitle className="text-blue-900">
                    Shareable Link
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-3">
                    <Input
                      value={
                        sessionInfo?.link
                        || `http://localhost:8080/join/${sessionId}`
                      }
                      readOnly
                      className="font-mono text-sm"
                      placeholder="localhost:8080/join/..."
                    />
                    <Button onClick={copyLink} variant="outline">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-sm text-gray-600 mt-2">
                    Send this link to the other party. They'll use it to join
                    your session.
                  </p>
                </CardContent>
              </Card>
              <Card
                className={
                  waiting
                    ? 'bg-orange-50 border-orange-200'
                    : 'bg-green-50 border-green-200'
                }
              >
                <CardContent className="pt-6">
                  <div className="flex items-start space-x-3">
                    {waiting ? (
                      <div className="w-8 h-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600 mr-2" />
                    ) : (
                      <div className="flex-shrink-0 pt-1">
                        <CheckCircle className="w-5 h-5 text-green-600" />
                      </div>
                    )}
                    <div>
                      <p
                        className={`font-medium ${waiting ? 'text-orange-900' : 'text-green-900'}`}
                      >
                        {waiting
                          ? 'Waiting for other party'
                          : 'Other party has joined!'}
                      </p>
                      {/* Integrate waiting/joined UI here */}
                      {waiting ? (
                        <div className="flex flex-col items-start mt-1">
                          <p className="text-sm text-orange-700">
                            Once they join and upload their file, you'll be able
                            to proceed with the intersection.
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Keep this page open. You'll be notified as soon as
                            the other party connects.
                          </p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-start mt-1">
                          <p className="text-green-700 font-semibold text-sm">
                            The other party has successfully uploaded their
                            file!
                          </p>
                          <p className="text-gray-700 text-xs mt-1">
                            Peer ID:{' '}
                            <span className="font-mono">{invitedPeerId}</span>
                          </p>
                          <Button
                            onClick={() =>
                              navigate(`/session/${sessionId}/execute`)
                            }
                            className="mt-4 w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-4 text-base rounded-lg shadow-lg hover:shadow-xl transition-all duration-200"
                          >
                            Start PSI Execution
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SessionReady;
