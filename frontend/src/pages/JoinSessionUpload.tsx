import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Shield, Upload, ArrowLeft, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const JoinSessionUpload = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch session info when component mounts
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'text/csv') {
      setFile(selectedFile);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    // Here you would process the CSV file in the browser
    // For now, we'll just navigate to the ready page
    // In the future, this is where you'd parse the CSV and store it in component state

    // Generate a mock PeerJS ID (in real implementation, this would come from PeerJS)
    const mockPeerId = 'peerjs-' + Math.random().toString(36).substr(2, 9);

    // Register this peer ID with the backend
    try {
      const res = await fetch('/client/peerId', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          invitedPeerId: mockPeerId
        })
      });

      if (res.ok) {
        // Navigate to the joiner's ready page
        navigate(`/join/${sessionId}/ready`);
      }
    } catch (error) {
      console.error('Failed to register peer ID:', error);
    }
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
            <div className="text-sm text-gray-600">Upload Your Data</div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Upload Your Dataset
            </h2>
            <p className="text-lg text-gray-600">
              Join the session and upload your CSV file to begin
            </p>
          </div>

          <Card className="shadow-lg mb-6">
            <CardHeader>
              <CardTitle className="flex items-center">
                <FileText className="w-5 h-5 mr-2 text-blue-600" />
                Session Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <span className="font-medium text-gray-700">Session Name:</span>
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

          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="flex items-center">
                <Upload className="w-5 h-5 mr-2 text-blue-600" />
                Upload Your CSV File
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select CSV File
                  </label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                    required
                  />
                  <p className="text-sm text-gray-500 mt-1">
                    CSV files only • Maximum 10MB • Your data stays in your
                    browser
                  </p>
                </div>

                <Button
                  type="submit"
                  disabled={!file}
                  className="w-full bg-blue-600 hover:bg-blue-700 py-3 text-lg"
                >
                  Submit CSV & Join Session
                  <Upload className="ml-2 w-5 h-5" />
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default JoinSessionUpload;
