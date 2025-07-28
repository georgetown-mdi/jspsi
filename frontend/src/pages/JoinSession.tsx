import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Shield, Search, ArrowLeft, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const JoinSession = () => {
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams();
  const [sessionId, setSessionId] = useState(urlSessionId || '');
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSessionLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId.trim()) {
      setError('Please enter a session ID');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const res = await fetch(`/api/session/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionInfo(data);
      } else {
        setError('Session not found. Please check the session ID.');
      }
    } catch (err) {
      setError('Failed to look up session. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinSession = () => {
    // Navigate to the upload page for this session
    navigate(`/join/${sessionId}/upload`);
  };

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
            <div className="text-sm text-gray-600">Join Session</div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Join a Session
            </h2>
            <p className="text-lg text-gray-600">
              Enter the session ID to join an existing PSI session
            </p>
          </div>
          <div className="animate-fade-in">
          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center">
                <Search className="w-5 h-5 mr-2 text-blue-600" />
                Enter Session ID
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSessionLookup} className="space-y-4">
                <div>
                  <Label htmlFor="sessionId" className="text-base font-medium">
                    Session ID
                  </Label>
                  <Input
                    id="sessionId"
                    type="text"
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                    placeholder="Enter the session ID from your invitation"
                    className="mt-1"
                    required
                  />
                </div>

                {error && (
                  <div className="text-red-600 text-sm bg-red-50 p-3 rounded-lg">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-blue-600 hover:bg-blue-700 py-3 text-lg"
                >
                  {isLoading ? 'Looking up session...' : 'Look Up Session'}
                  <Search className="ml-2 w-5 h-5" />
                </Button>
              </form>
            </CardContent>
          </Card>
          </div>

   
          {sessionInfo && (
            <div className="animate-fade-in">
            <Card className="shadow-lg mt-6">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <FileText className="w-5 h-5 mr-2 text-blue-600" />
                  Session Found
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <span className="font-medium text-gray-700">
                    Session Name:
                  </span>
                  <span className="ml-2 text-gray-900">
                    {sessionInfo.sessionName}
                  </span>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Initiator:</span>
                  <span className="ml-2 text-gray-900">
                    {sessionInfo.initiatedName}
                  </span>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Invitee:</span>
                  <span className="ml-2 text-gray-900">
                    {sessionInfo.invitedName}
                  </span>
                </div>
                {sessionInfo.description && (
                  <div>
                    <span className="font-medium text-gray-700">
                      Description:
                    </span>
                    <span className="ml-2 text-gray-900 break-words">
                      {sessionInfo.description}
                    </span>
                  </div>
                )}

                <Button
                  onClick={handleJoinSession}
                  className="w-full bg-green-600 hover:bg-green-700 py-3 text-lg mt-4"
                >
                  Join Session & Upload Data
                  <FileText className="ml-2 w-5 h-5" />
                </Button>
              </CardContent>
            </Card>
            </div>
          )}
 
        </div>
      </div>
    </div>
  );
};

export default JoinSession;
