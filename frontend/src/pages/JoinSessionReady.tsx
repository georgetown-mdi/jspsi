import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Shield, CheckCircle, ArrowLeft, Users, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const JoinSessionReady = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchSession = async () => {
      try {
        const res = await fetch(`/api/session/${sessionId}`);
        if (res.ok) {
          const data = await res.json();
          setSessionInfo(data);
        } else if (res.status === 404) {
          // Session not found
          setSessionInfo(null);
        } else {
          // Other error
          console.error('Failed to fetch session:', res.status);
        }
      } catch (error) {
        console.error('Failed to fetch session:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSession();
  }, [sessionId]);

  const handleStartPSI = () => {
    // Navigate to the PSI execution page
    navigate(`/execute/${sessionId}`);
  };

  if (isLoading) {
    return <div className="text-center py-12">Loading session info...</div>;
  }

  if (!sessionInfo) {
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
            </div>
          </div>
        </header>

        <div className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8 text-red-600" />
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Session Not Found
            </h2>
            <p className="text-lg text-gray-600 mb-6">
              The session ID "{sessionId}" does not exist or has expired.
            </p>
            <div className="space-y-4">
              <Button
                onClick={() => navigate('/join')}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Try Another Session ID
              </Button>
              <div>
                <Button
                  variant="outline"
                  onClick={() => navigate('/')}
                  className="border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Back to Home
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
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
            <div className="text-sm text-gray-600">Ready to Execute</div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Both Parties Ready!
            </h2>
            <p className="text-lg text-gray-600">
              You've successfully joined the session. Both parties are now ready
              for PSI execution.
            </p>
          </div>

          <div className="space-y-6">
            <Card className="shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Users className="w-5 h-5 mr-2 text-blue-600" />
                  Session Summary
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
              </CardContent>
            </Card>

            <div className="bg-green-50 border border-green-200 rounded-lg p-6">
              <div className="flex items-center space-x-3 mb-4">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-900">
                    Both parties ready
                  </p>
                  <p className="text-sm text-green-700">
                    All files uploaded and validated
                  </p>
                </div>
              </div>

              <Button
                onClick={handleStartPSI}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-4 text-base rounded-lg shadow-lg hover:shadow-xl transition-all duration-200"
              >
                Start PSI Execution
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default JoinSessionReady;
