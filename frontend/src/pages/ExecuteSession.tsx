import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Shield,
  ArrowLeft,
  Download,
  Users,
  CheckCircle,
  AlertCircle,
  Play
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import LoadingSpinner from '@/components/LoadingSpinner';

const ExecuteSession = () => {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { toast } = useToast();
  const [step, setStep] = useState<
    'ready' | 'executing' | 'complete' | 'error'
  >('ready');
  const [progress, setProgress] = useState(0);
  const [progressStep, setProgressStep] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [executionTime, setExecutionTime] = useState<number | null>(null);
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

  const mockResults = [
    "john.doe@example.com",
    "sarah.smith@company.com", 
    "mike.johnson@business.org",
    "lisa.brown@enterprise.net",
    "david.wilson@corporation.com"
  ];

  const executeSteps = [
    { step: "Initializing secure connection...", duration: 1000 },
    { step: "Performing cryptographic setup...", duration: 1500 },
    { step: "Processing your dataset...", duration: 2000 },
    { step: "Computing private intersection...", duration: 2500 },
    { step: "Finalizing results...", duration: 1000 }
  ];

  const startExecution = async () => {
    setStep('executing');
    setProgress(0);
    const startTime = Date.now();

    try {
      let currentProgress = 0;
      const totalSteps = executeSteps.length;

      for (let i = 0; i < executeSteps.length; i++) {
        setProgressStep(executeSteps[i].step);

        // Simulate step execution
        await new Promise(resolve => setTimeout(resolve, executeSteps[i].duration));
        
        currentProgress = ((i + 1) / totalSteps) * 100;
        setProgress(currentProgress);
      }

      // Simulate successful completion
      setResults(mockResults);
      setExecutionTime(Date.now() - startTime);
      setStep('complete');

      toast({
        title: 'PSI Complete!',
        description: `Found ${mockResults.length} overlapping items.`
      });
    } catch (error) {
      setStep('error');
      toast({
        title: "Execution Failed",
        description: "An error occurred during PSI execution.",
        variant: "destructive"
      });
    }
  };

  const downloadResults = () => {
    const csvContent = "data:text/csv;charset=utf-8," + 
      "Common Items\n" + 
      results.join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `psi_results_${sessionId}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast({
      title: 'Download started',
      description: 'Your PSI results are being downloaded.'
    });
  };

  const startNewSession = () => {
    navigate('/create');
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
            <div className="text-sm text-gray-600">Session: {sessionId}</div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-3xl mx-auto">
          {isLoading ? (
            <div className="text-center py-12">
              <LoadingSpinner className="w-8 h-8 mx-auto mb-4" />
              <p className="text-gray-600">Loading session information...</p>
            </div>
          ) : !sessionInfo ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-8 h-8 text-red-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                Session Not Found
              </h2>
              <p className="text-lg text-gray-600 mb-6">
                The session ID "{sessionId}" does not exist or has expired.
              </p>
              <Button
                onClick={() => navigate('/')}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Back to Home
              </Button>
            </div>
          ) : (
            step === 'ready' && (
              <div className="animate-fade-in">
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Play className="w-8 h-8 text-blue-600" />
                  </div>
                  <h2 className="text-3xl font-bold text-gray-900 mb-4">
                    Ready to Execute PSI
                  </h2>
                  <p className="text-lg text-gray-600">
                    Both parties have uploaded their datasets. Click below to
                    begin the private set intersection.
                  </p>
                </div>

              <div className="space-y-6">
                <Card className="shadow-lg">
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <Users className="w-5 h-5 mr-2 text-blue-600" />
                      Session Overview
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <h4 className="font-medium text-gray-900 mb-2">Session Details</h4>
                        <div className="space-y-1 text-sm text-gray-600">
                          <p><span className="font-medium">Name:</span> {sessionInfo.sessionName}</p>
                          <p><span className="font-medium">ID:</span> {sessionId}</p>
                          <p><span className="font-medium">Status:</span> Ready to execute</p>
                        </div>
                      </div>
                      <div>
                        <h4 className="font-medium text-gray-900 mb-2">Participants</h4>
                        <div className="space-y-2">
                          <div className="flex items-center space-x-2">
                            <CheckCircle className="w-4 h-4 text-green-600" />
                            <span className="text-sm text-gray-700">{sessionInfo.initiatedName} (Session Creator)</span>
                          </div>
                          <div className="flex items-center space-x-2">
                            <CheckCircle className="w-4 h-4 text-green-600" />
                            <span className="text-sm text-gray-700">{sessionInfo.invitedName} (Invitee)</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-blue-50 border-blue-200">
                  <CardContent className="pt-6">
                    <div className="text-center">
                      <h3 className="font-semibold text-blue-900 mb-2">What happens next?</h3>
                      <p className="text-sm text-blue-800 mb-4">
                        The PSI algorithm will securely compute the intersection of both datasets without 
                        revealing any information beyond the common items.
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-blue-700">
                        <div className="text-center">
                          <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center mx-auto mb-2">1</div>
                          <p>Secure connection established</p>
                        </div>
                        <div className="text-center">
                          <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center mx-auto mb-2">2</div>
                          <p>Cryptographic computation</p>
                        </div>
                        <div className="text-center">
                          <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center mx-auto mb-2">3</div>
                          <p>Results revealed</p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Button
                  onClick={startExecution}
                  className="w-full bg-blue-600 hover:bg-blue-700 py-4 text-lg font-semibold"
                >
                  <Play className="w-5 h-5 mr-2" />
                  Start Private Set Intersection
                </Button>
              </div>
            </div>
            )
          )}

          {!isLoading && sessionInfo && step === 'executing' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <LoadingSpinner className="w-8 h-8 text-blue-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">Executing PSI</h2>
                <p className="text-lg text-gray-600">
                  Please wait while we securely compute the intersection...
                </p>
              </div>

              <Card className="shadow-lg">
                <CardContent className="pt-6">
                  <div className="space-y-6">
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-sm font-medium text-gray-700">{progressStep}</span>
                        <span className="text-sm font-medium text-gray-700">{Math.round(progress)}%</span>
                      </div>
                      <Progress value={progress} className="h-3" />
                    </div>

                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <div className="flex items-center space-x-2">
                        <AlertCircle className="w-5 h-5 text-yellow-600" />
                        <div>
                          <p className="font-medium text-yellow-900">Processing in progress</p>
                          <p className="text-sm text-yellow-800">
                            Do not close this window. The cryptographic computation is running securely.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {!isLoading && sessionInfo && step === 'complete' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">PSI Complete!</h2>
                <p className="text-lg text-gray-600">
                  The private set intersection has been successfully computed.
                </p>
              </div>

              <div className="space-y-6">
                <Card className="shadow-lg">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span>Intersection Results</span>
                      <Button onClick={downloadResults} variant="outline" size="sm">
                        <Download className="w-4 h-4 mr-2" />
                        Download CSV
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                        <div className="bg-blue-50 p-4 rounded-lg">
                          <p className="text-2xl font-bold text-blue-600">{results.length}</p>
                          <p className="text-sm text-blue-800">Common Items</p>
                        </div>
                        <div className="bg-green-50 p-4 rounded-lg">
                          <p className="text-2xl font-bold text-green-600">{executionTime && (executionTime / 1000).toFixed(1)}s</p>
                          <p className="text-sm text-green-800">Execution Time</p>
                        </div>
                        <div className="bg-purple-50 p-4 rounded-lg">
                          <p className="text-2xl font-bold text-purple-600">100%</p>
                          <p className="text-sm text-purple-800">Privacy Maintained</p>
                        </div>
                      </div>

                      {results.length > 0 && (
                        <div>
                          <h4 className="font-medium text-gray-900 mb-3">Common Items Found:</h4>
                          <div className="bg-gray-50 rounded-lg p-4 max-h-64 overflow-y-auto">
                            <div className="space-y-2">
                              {results.map((item, index) => (
                                <div key={index} className="flex items-center space-x-2">
                                  <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                                  <span className="text-sm font-mono text-gray-700">{item}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <div className="flex space-x-4">
                  <Button
                    onClick={downloadResults}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download Results
                  </Button>
                  <Button
                    onClick={startNewSession}
                    variant="outline"
                    className="flex-1"
                  >
                    Start New Session
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!isLoading && sessionInfo && step === 'error' && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <AlertCircle className="w-8 h-8 text-red-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-4">Execution Failed</h2>
                <p className="text-lg text-gray-600">
                  An error occurred during the PSI computation. Please try again.
                </p>
              </div>

              <Card className="shadow-lg border-red-200">
                <CardContent className="pt-6">
                  <div className="bg-red-50 p-4 rounded-lg">
                    <p className="text-sm text-red-800">
                      The private set intersection could not be completed. This might be due to:
                    </p>
                    <ul className="list-disc list-inside text-sm text-red-700 mt-2 space-y-1">
                      <li>Network connection issues</li>
                      <li>File format incompatibility</li>
                      <li>Computational timeout</li>
                    </ul>
                  </div>
                  
                  <div className="flex space-x-4 mt-6">
                    <Button
                      onClick={() => setStep('ready')}
                      className="flex-1 bg-blue-600 hover:bg-blue-700"
                    >
                      Try Again
                    </Button>
                    <Button
                      onClick={() => navigate('/')}
                      variant="outline"
                      className="flex-1"
                    >
                      Back to Home
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExecuteSession;
