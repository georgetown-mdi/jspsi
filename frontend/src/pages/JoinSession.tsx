
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Shield, ArrowLeft, Users, FileText, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import FileUpload from "@/components/FileUpload";
import LoadingSpinner from "@/components/LoadingSpinner";

const JoinSession = () => {
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams();
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState(urlSessionId || "");
  const [sessionName, setSessionName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [sessionFound, setSessionFound] = useState(false);
  const [step, setStep] = useState<'input' | 'upload' | 'ready'>('input');

  useEffect(() => {
    if (urlSessionId) {
      handleSessionLookup(urlSessionId);
    }
  }, [urlSessionId]);

  const handleSessionLookup = async (id: string) => {
    if (!id.trim()) {
      toast({
        title: "Session ID required",
        description: "Please enter or paste a session ID.",
        variant: "destructive"
      });
      return;
    }

    setIsLoading(true);
    
    // Simulate session lookup
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Mock session data - in real app this would come from the backend
    setSessionName("Customer Overlap Analysis");
    setSessionFound(true);
    setStep('upload');
    setIsLoading(false);

    toast({
      title: "Session found!",
      description: "You can now upload your dataset to join."
    });
  };

  const handleJoinSession = async () => {
    if (!file) {
      toast({
        title: "File required",
        description: "Please upload your CSV file to join the session.",
        variant: "destructive"
      });
      return;
    }

    setIsJoining(true);
    
    // Simulate joining process
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    setStep('ready');
    setIsJoining(false);

    toast({
      title: "Successfully joined!",
      description: "You're now part of the PSI session."
    });
  };

  const proceedToExecution = () => {
    navigate(`/execute/${sessionId}`);
  };

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
            </div>
            <div className="text-sm text-gray-600">
              Join Session
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          {step === 'input' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-gray-900 mb-4">Join PSI Session</h2>
                <p className="text-lg text-gray-600">
                  Enter the session link or ID shared with you
                </p>
              </div>

              <Card className="shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <Users className="w-5 h-5 mr-2 text-blue-600" />
                    Session Access
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <Label htmlFor="sessionLink" className="text-base font-medium">
                      Session Link or ID
                    </Label>
                    <Input
                      id="sessionLink"
                      value={sessionId}
                      onChange={(e) => {
                        const value = e.target.value;
                        // Extract session ID from URL if a full link is pasted
                        const match = value.match(/\/join\/([a-zA-Z0-9]+)/);
                        setSessionId(match ? match[1] : value);
                      }}
                      placeholder="Paste the session link or enter session ID"
                      className="mt-2"
                    />
                    <p className="text-sm text-gray-500 mt-1">
                      This should have been shared with you by the session creator
                    </p>
                  </div>

                  <Button
                    onClick={() => handleSessionLookup(sessionId)}
                    disabled={isLoading || !sessionId.trim()}
                    className="w-full bg-blue-600 hover:bg-blue-700 py-3 text-lg"
                  >
                    {isLoading ? (
                      <>
                        <LoadingSpinner className="mr-2" />
                        Looking up session...
                      </>
                    ) : (
                      "Find Session"
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {step === 'upload' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Users className="w-8 h-8 text-blue-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">Session Found!</h2>
                <p className="text-lg text-gray-600">
                  Upload your dataset to join the PSI session
                </p>
              </div>

              <div className="space-y-6">
                <Card className="shadow-lg border-blue-200">
                  <CardHeader>
                    <CardTitle>Session Information</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-sm font-medium text-gray-600">Session Name</Label>
                        <p className="text-lg font-medium text-gray-900">{sessionName}</p>
                      </div>
                      <div>
                        <Label className="text-sm font-medium text-gray-600">Session ID</Label>
                        <p className="text-sm font-mono text-gray-700 bg-gray-100 px-3 py-2 rounded">
                          {sessionId}
                        </p>
                      </div>
                      <div className="flex items-center space-x-2 text-green-600">
                        <CheckCircle className="w-4 h-4" />
                        <span className="text-sm font-medium">Session creator is ready</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="shadow-lg">
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <FileText className="w-5 h-5 mr-2 text-blue-600" />
                      Upload Your Dataset
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FileUpload
                      onFileSelect={setFile}
                      selectedFile={file}
                      accept=".csv"
                      maxSize={10 * 1024 * 1024} // 10MB
                    />
                    <p className="text-sm text-gray-500">
                      CSV files only • Maximum 10MB • Your data stays in your browser
                    </p>

                    <Button
                      onClick={handleJoinSession}
                      disabled={isJoining || !file}
                      className="w-full bg-blue-600 hover:bg-blue-700 py-3 text-lg"
                    >
                      {isJoining ? (
                        <>
                          <LoadingSpinner className="mr-2" />
                          Joining session...
                        </>
                      ) : (
                        "Join Session"
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {step === 'ready' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">Ready to Proceed!</h2>
                <p className="text-lg text-gray-600">
                  You've successfully joined the session. Both parties are now ready for PSI execution.
                </p>
              </div>

              <div className="space-y-6">
                <Card className="shadow-lg">
                  <CardHeader>
                    <CardTitle>Session Summary</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-sm font-medium text-gray-600">Session Name</Label>
                          <p className="font-medium text-gray-900">{sessionName}</p>
                        </div>
                        <div>
                          <Label className="text-sm font-medium text-gray-600">Your File</Label>
                          <p className="text-sm text-gray-700">{file?.name}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-green-50 rounded-lg">
                        <div className="flex items-center space-x-3">
                          <CheckCircle className="w-5 h-5 text-green-600" />
                          <div>
                            <p className="font-medium text-green-900">Both parties ready</p>
                            <p className="text-sm text-green-700">All files uploaded and validated</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Button
                  onClick={proceedToExecution}
                  className="w-full bg-blue-600 hover:bg-blue-700 py-3 text-lg"
                >
                  Proceed to PSI Execution
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default JoinSession;
