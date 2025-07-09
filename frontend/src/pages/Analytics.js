import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Drawer,
  IconButton,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Collapse,
} from '@mui/material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  LineChart,
  Line,
  ResponsiveContainer,
  ComposedChart,
} from 'recharts';
import { AnalyticsSkeleton } from '../components/common/SkeletonLoaders';
import {
  FileDownload,
  Close,
  FilterList,
  TrendingUp,
  TrendingDown,
  ExpandMore,
  ExpandLess,
} from '@mui/icons-material';
// import { callsApi } from '../services/api'; // Will be used when implementing real API calls

const Analytics = () => {
  const [timeRange, setTimeRange] = useState('7days');
  const [selectedAgent, setSelectedAgent] = useState('all');
  const [selectedOffice, setSelectedOffice] = useState('all');
  const [selectedCallType, setSelectedCallType] = useState('all');
  const [loading, setLoading] = useState(true); // Will be used for loading states in real implementation
  const [analyticsData, setAnalyticsData] = useState({});
  const [selectedDate, setSelectedDate] = useState(null);
  const [showCallsDetail, setShowCallsDetail] = useState(false);
  const [callsForDate, setCallsForDate] = useState([]);
  const [showFilters, setShowFilters] = useState(false);
  const [exportDialog, setExportDialog] = useState(false);

  useEffect(() => {
    fetchAnalyticsData();
  }, [timeRange, selectedAgent, selectedOffice, selectedCallType]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAnalyticsData = async () => {
    try {
      setLoading(true);
      // In a real implementation, this would fetch analytics from the API
      // For now, we'll use mock data
      setAnalyticsData(generateMockAnalytics());
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
      setAnalyticsData(generateMockAnalytics());
    } finally {
      setLoading(false);
    }
  };

  const generateMockAnalytics = () => {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dates = ['2024-01-15', '2024-01-16', '2024-01-17', '2024-01-18', '2024-01-19', '2024-01-20', '2024-01-21'];
    
    return {
      callVolume: days.map((day, index) => ({
        date: day,
        fullDate: dates[index],
        calls: Math.floor(Math.random() * 30) + 15,
      })),
      sentimentTrends: days.map((day, index) => ({
        date: day,
        fullDate: dates[index],
        positive: Math.floor(Math.random() * 20) + 40,
        neutral: Math.floor(Math.random() * 15) + 20,
        negative: Math.floor(Math.random() * 10) + 5,
      })),
      avgResponseTime: days.map((day, index) => ({
        date: day,
        fullDate: dates[index],
        time: +(Math.random() * 2 + 1).toFixed(1),
      })),
      resolutionRate: days.map((day, index) => ({
        date: day,
        fullDate: dates[index],
        rate: +(Math.random() * 10 + 85).toFixed(1),
        resolved: Math.floor(Math.random() * 10) + 85,
        unresolved: Math.floor(Math.random() * 15) + 5,
        trend: Math.random() > 0.5 ? 'up' : 'down',
      })),
      filters: {
        agents: ['All Agents', 'Dr. Smith', 'Nurse Johnson', 'Reception Bot', 'Emergency AI'],
        offices: ['All Offices', 'Main Clinic', 'Downtown Branch', 'Urgent Care', 'Pharmacy'],
        callTypes: ['All Types', 'Emergency', 'General Inquiry', 'Appointment', 'Billing', 'Prescription'],
      },
    };
  };

  const generateMockCallsForDate = (date) => {
    const callTypes = ['Emergency', 'General Inquiry', 'Appointment', 'Billing', 'Prescription'];
    const agents = ['Dr. Smith', 'Nurse Johnson', 'Reception Bot', 'Emergency AI'];
    const sentiments = ['positive', 'neutral', 'negative'];
    
    return Array.from({ length: Math.floor(Math.random() * 15) + 10 }, (_, i) => ({
      id: `call-${date}-${i}`,
      time: `${Math.floor(Math.random() * 12) + 8}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}`,
      caller: `Caller ${i + 1}`,
      agent: agents[Math.floor(Math.random() * agents.length)],
      type: callTypes[Math.floor(Math.random() * callTypes.length)],
      duration: `${Math.floor(Math.random() * 10) + 2}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}`,
      sentiment: sentiments[Math.floor(Math.random() * sentiments.length)],
      resolved: Math.random() > 0.2,
      transcript: `Sample call transcript for call ${i + 1}...`,
    }));
  };

  const handleBarClick = (data) => {
    setSelectedDate(data.fullDate);
    setCallsForDate(generateMockCallsForDate(data.fullDate));
    setShowCallsDetail(true);
  };

  const exportToCSV = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    
    // Call Volume Data
    csvContent += "Call Volume Data\n";
    csvContent += "Date,Calls\n";
    analyticsData.callVolume?.forEach(row => {
      csvContent += `${row.date},${row.calls}\n`;
    });
    
    csvContent += "\nSentiment Trends\n";
    csvContent += "Date,Positive,Neutral,Negative\n";
    analyticsData.sentimentTrends?.forEach(row => {
      csvContent += `${row.date},${row.positive},${row.neutral},${row.negative}\n`;
    });
    
    csvContent += "\nResolution Rate\n";
    csvContent += "Date,Rate,Resolved,Unresolved\n";
    analyticsData.resolutionRate?.forEach(row => {
      csvContent += `${row.date},${row.rate},${row.resolved},${row.unresolved}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `analytics-${timeRange}-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportToPDF = () => {
    // In a real implementation, you would use a library like jsPDF
    alert('PDF export would be implemented with a library like jsPDF or by sending data to a backend service.');
  };

  const getSentimentColor = (sentiment) => {
    switch (sentiment) {
      case 'positive': return '#4caf50';
      case 'neutral': return '#ff9800';
      case 'negative': return '#f44336';
      default: return '#9e9e9e';
    }
  };

  const getCallTypeColor = (type) => {
    const colors = {
      'Emergency': '#f44336',
      'General Inquiry': '#2196f3',
      'Appointment': '#4caf50',
      'Billing': '#ff9800',
      'Prescription': '#9c27b0',
    };
    return colors[type] || '#9e9e9e';
  };

  const calculateTrendLine = (data) => {
    const n = data.length;
    const sumX = data.reduce((sum, _, i) => sum + i, 0);
    const sumY = data.reduce((sum, item) => sum + item.rate, 0);
    const sumXY = data.reduce((sum, item, i) => sum + i * item.rate, 0);
    const sumXX = data.reduce((sum, _, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return data.map((item, i) => ({
      ...item,
      trendLine: slope * i + intercept,
    }));
  };

  const resolutionDataWithTrend = calculateTrendLine(analyticsData.resolutionRate || []);

  if (loading) {
    return (
      <Box>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h4">
            Analytics Dashboard
          </Typography>
        </Box>
        <AnalyticsSkeleton />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4">
          Analytics Dashboard
        </Typography>
        <Box display="flex" gap={2} alignItems="center">
          <Button
            variant="outlined"
            startIcon={<FilterList />}
            onClick={() => setShowFilters(!showFilters)}
            endIcon={showFilters ? <ExpandLess /> : <ExpandMore />}
          >
            Filters
          </Button>
          <Button
            variant="contained"
            startIcon={<FileDownload />}
            onClick={() => setExportDialog(true)}
          >
            Export
          </Button>
        </Box>
      </Box>

      {/* Enhanced Filters */}
      <Collapse in={showFilters}>
        <Card sx={{ mb: 3, p: 2 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={6} md={2.4}>
              <FormControl fullWidth size="small">
                <InputLabel>Time Range</InputLabel>
                <Select
                  value={timeRange}
                  label="Time Range"
                  onChange={(e) => setTimeRange(e.target.value)}
                >
                  <MenuItem value="7days">Last 7 Days</MenuItem>
                  <MenuItem value="30days">Last 30 Days</MenuItem>
                  <MenuItem value="90days">Last 90 Days</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <FormControl fullWidth size="small">
                <InputLabel>Agent</InputLabel>
                <Select
                  value={selectedAgent}
                  label="Agent"
                  onChange={(e) => setSelectedAgent(e.target.value)}
                >
                  <MenuItem value="all">All Agents</MenuItem>
                  <MenuItem value="dr-smith">Dr. Smith</MenuItem>
                  <MenuItem value="nurse-johnson">Nurse Johnson</MenuItem>
                  <MenuItem value="reception-bot">Reception Bot</MenuItem>
                  <MenuItem value="emergency-ai">Emergency AI</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <FormControl fullWidth size="small">
                <InputLabel>Office</InputLabel>
                <Select
                  value={selectedOffice}
                  label="Office"
                  onChange={(e) => setSelectedOffice(e.target.value)}
                >
                  <MenuItem value="all">All Offices</MenuItem>
                  <MenuItem value="main">Main Clinic</MenuItem>
                  <MenuItem value="downtown">Downtown Branch</MenuItem>
                  <MenuItem value="urgent">Urgent Care</MenuItem>
                  <MenuItem value="pharmacy">Pharmacy</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <FormControl fullWidth size="small">
                <InputLabel>Call Type</InputLabel>
                <Select
                  value={selectedCallType}
                  label="Call Type"
                  onChange={(e) => setSelectedCallType(e.target.value)}
                >
                  <MenuItem value="all">All Types</MenuItem>
                  <MenuItem value="emergency">Emergency</MenuItem>
                  <MenuItem value="inquiry">General Inquiry</MenuItem>
                  <MenuItem value="appointment">Appointment</MenuItem>
                  <MenuItem value="billing">Billing</MenuItem>
                  <MenuItem value="prescription">Prescription</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <Button 
                variant="outlined" 
                size="small" 
                onClick={() => {
                  setSelectedAgent('all');
                  setSelectedOffice('all');
                  setSelectedCallType('all');
                }}
              >
                Clear Filters
              </Button>
            </Grid>
          </Grid>
        </Card>
      </Collapse>

      <Grid container spacing={3}>
        {/* Clickable Call Volume Chart */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Daily Call Volume
                <Typography variant="caption" display="block" color="text.secondary">
                  Click on a bar to view calls for that day
                </Typography>
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analyticsData.callVolume} onClick={handleBarClick}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <RechartsTooltip 
                    cursor={{ fill: 'rgba(25, 118, 210, 0.1)' }}
                    content={({ active, payload, label }) => {
                      if (active && payload && payload.length) {
                        return (
                          <Box sx={{ 
                            bgcolor: 'background.paper', 
                            p: 1, 
                            border: 1, 
                            borderColor: 'divider',
                            borderRadius: 1,
                            boxShadow: 2
                          }}>
                            <Typography variant="body2">{`${label}: ${payload[0].value} calls`}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              Click to view details
                            </Typography>
                          </Box>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar 
                    dataKey="calls" 
                    fill="#1976d2" 
                    cursor="pointer"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Stacked Bar Chart for Sentiment Trends */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Sentiment Trends by Day
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analyticsData.sentimentTrends}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <RechartsTooltip />
                  <Legend />
                  <Bar dataKey="positive" stackId="sentiment" fill="#4caf50" name="Positive" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="neutral" stackId="sentiment" fill="#ff9800" name="Neutral" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="negative" stackId="sentiment" fill="#f44336" name="Negative" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Average Response Time */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Average Response Time (seconds)
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analyticsData.avgResponseTime}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <RechartsTooltip />
                  <Line 
                    type="monotone" 
                    dataKey="time" 
                    stroke="#9c27b0" 
                    strokeWidth={3}
                    dot={{ r: 6, fill: '#9c27b0' }}
                    activeDot={{ r: 8, fill: '#9c27b0' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Enhanced Resolution Rate with Trend Line */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Resolution Rate with Trend Analysis
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={resolutionDataWithTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <RechartsTooltip 
                    content={({ active, payload, label }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <Box sx={{ 
                            bgcolor: 'background.paper', 
                            p: 1, 
                            border: 1, 
                            borderColor: 'divider',
                            borderRadius: 1,
                            boxShadow: 2
                          }}>
                            <Typography variant="body2">{`${label}: ${data.rate}%`}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              Resolved: {data.resolved} | Unresolved: {data.unresolved}
                            </Typography>
                            <Box display="flex" alignItems="center" mt={0.5}>
                              {data.trend === 'up' ? (
                                <TrendingUp sx={{ fontSize: 16, color: 'success.main', mr: 0.5 }} />
                              ) : (
                                <TrendingDown sx={{ fontSize: 16, color: 'error.main', mr: 0.5 }} />
                              )}
                              <Typography variant="caption">
                                {data.trend === 'up' ? 'Improving' : 'Declining'}
                              </Typography>
                            </Box>
                          </Box>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar 
                    dataKey="rate" 
                    fill="#4caf50" 
                    radius={[4, 4, 0, 0]}
                    fillOpacity={0.8}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="trendLine" 
                    stroke="#1976d2" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                    name="Trend"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Calls Detail Drawer */}
      <Drawer
        anchor="right"
        open={showCallsDetail}
        onClose={() => setShowCallsDetail(false)}
        sx={{
          '& .MuiDrawer-paper': {
            width: { xs: '100%', sm: 600 },
            p: 0,
          },
        }}
      >
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Box display="flex" justifyContent="space-between" alignItems="center">
            <Typography variant="h6">
              Calls for {selectedDate}
            </Typography>
            <IconButton onClick={() => setShowCallsDetail(false)}>
              <Close />
            </IconButton>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {callsForDate.length} calls found
          </Typography>
        </Box>
        
        <Box sx={{ p: 2, overflow: 'auto' }}>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Caller</TableCell>
                  <TableCell>Agent</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Sentiment</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {callsForDate.map((call) => (
                  <TableRow key={call.id} hover>
                    <TableCell>{call.time}</TableCell>
                    <TableCell>{call.caller}</TableCell>
                    <TableCell>{call.agent}</TableCell>
                    <TableCell>
                      <Chip
                        label={call.type}
                        size="small"
                        sx={{
                          bgcolor: getCallTypeColor(call.type),
                          color: 'white',
                          fontSize: '0.7rem',
                        }}
                      />
                    </TableCell>
                    <TableCell>{call.duration}</TableCell>
                    <TableCell>
                      <Chip
                        label={call.sentiment}
                        size="small"
                        sx={{
                          bgcolor: getSentimentColor(call.sentiment),
                          color: 'white',
                          fontSize: '0.7rem',
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={call.resolved ? 'Resolved' : 'Unresolved'}
                        size="small"
                        color={call.resolved ? 'success' : 'error'}
                        variant="outlined"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      </Drawer>

      {/* Export Dialog */}
      <Dialog open={exportDialog} onClose={() => setExportDialog(false)}>
        <DialogTitle>Export Analytics Data</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Choose your preferred export format for the analytics data.
          </Typography>
          <Box display="flex" flexDirection="column" gap={2}>
            <Button
              variant="outlined"
              startIcon={<FileDownload />}
              onClick={() => {
                exportToCSV();
                setExportDialog(false);
              }}
              fullWidth
            >
              Export as CSV
            </Button>
            <Button
              variant="outlined"
              startIcon={<FileDownload />}
              onClick={() => {
                exportToPDF();
                setExportDialog(false);
              }}
              fullWidth
            >
              Export as PDF
            </Button>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportDialog(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Analytics; 